/** Real HTTPS OIDC protocol integration: ephemeral test authority, real PKCE/JWKS/signatures/cookies. */
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import https from "node:https";
import tls from "node:tls";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { accessFromEnv } from "../access.js";
import { boundary, errorBoundary } from "../gateway.js";

test("OIDC browser login verifies HTTPS discovery, PKCE, nonce, state, encrypted cookie and CSRF", async () => {
  const dir=mkdtempSync(join(tmpdir(),"alfa-oidc-"));
  const authorities=tls.getCACertificates("default");
  let authority: ReturnType<typeof https.createServer> | undefined;
  let gateway: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",join(dir,"key.pem"),"-out",join(dir,"cert.pem"),"-days","1","-subj","/CN=127.0.0.1","-addext","subjectAltName=IP:127.0.0.1","-addext","basicConstraints=critical,CA:TRUE"],{stdio:"ignore"});
    tls.setDefaultCACertificates([...authorities,readFileSync(join(dir,"cert.pem"),"utf8")]);
    const pair=await generateKeyPair("RS256");
    const jwk={...await exportJWK(pair.publicKey),kid:"test-current"};
    let issuer="", publicOrigin="", nonce="", challenge="", grants=0;
    const idp=express();idp.use(express.urlencoded({extended:false}));
    idp.get("/.well-known/openid-configuration",(_req,res)=>res.json({issuer,authorization_endpoint:issuer+"/authorize",token_endpoint:issuer+"/token",jwks_uri:issuer+"/jwks",response_types_supported:["code"],subject_types_supported:["public"],id_token_signing_alg_values_supported:["RS256"],code_challenge_methods_supported:["S256"],token_endpoint_auth_methods_supported:["none"]}));
    idp.get("/jwks",(_req,res)=>res.json({keys:[jwk]}));
    idp.post("/token",async(req,res)=>{
      assert.equal(req.body.grant_type,"authorization_code");assert.equal(req.body.redirect_uri,publicOrigin+"/auth/callback");
      assert.equal(req.body.client_id,"browser");assert.equal(createHash("sha256").update(req.body.code_verifier).digest("base64url"),challenge);
      if(req.body.code!=="one-time-code" || grants++) return res.status(400).json({error:"invalid_grant"});
      const token=await new SignJWT({sub:"alice",company_ids:["A"],roles:[],nonce}).setProtectedHeader({alg:"RS256",kid:jwk.kid}).setIssuer(issuer).setAudience("browser").setIssuedAt().setExpirationTime("10m").sign(pair.privateKey);
      res.json({access_token:"not-a-browser-identity",token_type:"Bearer",expires_in:600,id_token:token});
    });
    authority=https.createServer({key:readFileSync(join(dir,"key.pem")),cert:readFileSync(join(dir,"cert.pem"))},idp).listen(0,"127.0.0.1");await once(authority,"listening");
    issuer=`https://127.0.0.1:${(authority.address() as {port:number}).port}`;
    const app=express();boundary(app);
    gateway=app.listen(0,"127.0.0.1");await once(gateway,"listening");const base=`http://127.0.0.1:${(gateway.address() as {port:number}).port}`;
    publicOrigin=base.replace("http:","https:");
    const access=await accessFromEnv({AUTH_MODE:"oidc",OIDC_ISSUER:issuer,OIDC_CLIENT_ID:"browser",OIDC_AUDIENCE:"alfa-api",AUTH_COOKIE_KEY:randomBytes(32).toString("base64url"),INTERNAL_API_TOKEN:randomBytes(32).toString("base64url"),PUBLIC_BASE_URL:publicOrigin});
    access.install(app);
    app.get("/v1/companies/:id",(_req,res)=>res.json({principal:res.locals.principal}));app.post("/v1/rank",(_req,res)=>res.json({ok:true}));app.use(errorBoundary);
    const login=await fetch(base+"/auth/login",{redirect:"manual"});assert.equal(login.status,302);
    const flow=login.headers.getSetCookie()[0];assert.match(flow,/HttpOnly/);assert.match(flow,/Secure/);assert.match(flow,/SameSite=Lax/);
    const redirect=new URL(login.headers.get("location")!);assert.equal(redirect.origin,issuer);assert.equal(redirect.searchParams.get("code_challenge_method"),"S256");
    nonce=redirect.searchParams.get("nonce")!;challenge=redirect.searchParams.get("code_challenge")!;
    const callback="/auth/callback?code=one-time-code&state="+redirect.searchParams.get("state");
    assert.equal((await fetch(base+callback,{redirect:"manual"})).status,401,"callback without encrypted flow cookie");
    assert.equal((await fetch(base+callback+"wrong",{headers:{Cookie:flow.split(";")[0]},redirect:"manual"})).status,401,"state mismatch");
    const completed=await fetch(base+callback,{headers:{Cookie:flow.split(";")[0]},redirect:"manual"});assert.equal(completed.status,302,await completed.text());
    const session=completed.headers.getSetCookie().find(v=>v.startsWith("__Host-alfa-session="))!;assert.ok(session);assert.ok(!session.includes("alice"));
    const headers={Cookie:session.split(";")[0]};
    const profile=await fetch(base+"/v1/companies/A",{headers});assert.equal(profile.status,200);assert.equal((await profile.json()).principal.subject,"alice");
    assert.equal((await fetch(base+"/v1/companies/B",{headers})).status,403);
    assert.equal((await fetch(base+"/v1/companies/A",{headers:{Cookie:headers.Cookie.slice(0,-3)+"xxx"}})).status,401);
    assert.equal((await fetch(base+"/v1/rank",{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:'{"company_id":"A"}'})).status,403,"CSRF without Origin");
    assert.equal((await fetch(base+"/v1/rank",{method:"POST",headers:{...headers,Origin:publicOrigin,"Content-Type":"application/json"},body:'{"company_id":"A"}'})).status,200);
    assert.equal((await fetch(base+"/auth/logout",{method:"POST",headers})).status,403);
    const logout=await fetch(base+"/auth/logout",{method:"POST",headers:{...headers,Origin:publicOrigin}});assert.equal(logout.status,204);assert.match(logout.headers.get("set-cookie")!,/Expires=Thu, 01 Jan 1970/);
    assert.equal((await fetch(base+callback,{headers:{Cookie:flow.split(";")[0]},redirect:"manual"})).status,401,"authorization code cannot be replayed");
  } finally {
    gateway?.closeAllConnections(); if(gateway) await new Promise<void>(resolve=>gateway!.close(()=>resolve()));
    authority?.closeAllConnections(); if(authority) await new Promise<void>(resolve=>authority!.close(()=>resolve()));
    tls.setDefaultCACertificates(authorities);rmSync(dir,{recursive:true,force:true});
  }
});
