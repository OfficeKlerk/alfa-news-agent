import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import express from "express";
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from "jose";
import { verifyIdentity, enforceTenant, principalFromClaims, accessFromEnv } from "../access.js";
import { internalAccess } from "../internal-access.js";
import { boundary, errorBoundary } from "../gateway.js";

const issuer = "https://identity.example.org", audience = "alfa-api";
test("signed expiring JWT identities reject forgery, wrong issuer/audience, expiry and missing grants", async () => {
  const pair = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: "current" }] });
  const sign = (claims: Record<string, unknown>, iss = issuer, aud = audience, seconds = 600) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "current" }).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(Math.floor(Date.now()/1000) + seconds).sign(pair.privateKey);
  const token = await sign({ sub: "user-a", company_ids: ["A", "A"], roles: [] });
  assert.deepEqual(await verifyIdentity(token, keys, issuer, audience), { subject: "user-a", companies: ["A"], roles: [] });
  for (const invalid of [token.slice(0,-5) + "AAAAA", await sign({sub:"user-a",company_ids:["A"]}, "https://evil.example"), await sign({sub:"user-a",company_ids:["A"]}, issuer, "other"), await sign({sub:"user-a",company_ids:["A"]}, issuer, audience, -60), await sign({sub:"user-a"})]) {
    await assert.rejects(() => verifyIdentity(invalid, keys, issuer, audience));
  }
  assert.throws(() => principalFromClaims({sub:"u",company_ids:["*"]}));
  const malformed = await new SignJWT({ sub:"u", company_ids:["A"] }).setProtectedHeader({alg:"RS256",kid:"current"}).setIssuer(issuer).setAudience(audience).sign(pair.privateKey);
  await assert.rejects(() => verifyIdentity(malformed, keys, issuer, audience));
});
test("real HTTP tenant authorization rejects alternate encodings, trailing slashes, forged headers and legacy/admin routes", async () => {
  const pair = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({keys:[{...await exportJWK(pair.publicKey),kid:"key"}]});
  const token = await new SignJWT({sub:"u",company_ids:["A"],roles:[]}).setProtectedHeader({alg:"RS256",kid:"key"}).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("10m").sign(pair.privateKey);
  const app=express(); boundary(app); let reached=0;
  app.use(async(req,res,next)=>{
    try { res.locals.principal=await verifyIdentity((req.get("Authorization")??"").replace(/^Bearer /,""),keys,issuer,audience); }
    catch { return res.status(401).end(); }
    enforceTenant(req,res.locals.principal); next();
  });
  app.use((_req,res)=>{reached++;res.json({ok:true});});app.use(errorBoundary);
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address() as {port:number};const base=`http://127.0.0.1:${address.port}`;
  const headers={Authorization:"Bearer "+token,"Content-Type":"application/json"};
  try {
    assert.equal((await fetch(base+"/v1/companies/A",{headers})).status,200);
    for(const path of ["/v1/companies/B","/v1/companies/B/","/v1/companies/B/feed","/v1/companies/%42/feed","/v1/companies/%42","/v1/companies/%42/","/V1/companies/B","/api/companies/B","/API/bootstrap","/v1/analyses/saved?company_id=B"])
      assert.equal((await fetch(base+path,{headers})).status,403,path);
    assert.equal((await fetch(base+"/v1/rank",{method:"POST",headers,body:JSON.stringify({company_id:"B"})})).status,403);
    assert.equal((await fetch(base+"/v1/rank",{method:"POST",headers:{...headers,"X-Company-ID":"B"},body:JSON.stringify({company_id:"A"})})).status,403);
    assert.equal((await fetch(base+"/v1/rank",{method:"POST",headers,body:"{}"})).status,403);
    for(const path of ["/v1/news","/v1/feeds/refresh","/v1/learning/feedback"])
      assert.equal((await fetch(base+path,{method:"POST",headers,body:"{}"})).status,403);
    assert.equal((await fetch(base+"/v1/companies/A")).status,401);
    assert.equal(reached,1);
  } finally { server.close(); server.closeAllConnections(); await once(server,"close"); }
});
test("private service token is enforced over HTTP; health contains no company data", async()=>{
  const app=express();boundary(app);app.use(internalAccess({AUTH_MODE:"oidc",INTERNAL_API_TOKEN:"a".repeat(40)}));
  app.get("/v1/health",(_req,res)=>res.json({status:"ok"}));app.get("/v1/companies/A",(_req,res)=>res.json({id:"A"}));app.use(errorBoundary);
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    assert.equal((await fetch(base+"/v1/health")).status,200);
    for(const token of ["","wrong"]) assert.equal((await fetch(base+"/v1/companies/A",{headers:{"X-Internal-Token":token}})).status,401);
    assert.equal((await fetch(base+"/v1/companies/A",{headers:{"X-Internal-Token":"a".repeat(40)}})).status,200);
  } finally {server.close();server.closeAllConnections();await once(server,"close");}
  assert.throws(()=>internalAccess({AUTH_MODE:"oidc"}));
  await assert.rejects(()=>accessFromEnv({}));
  await assert.rejects(()=>accessFromEnv({AUTH_MODE:"development",LLM_MODE:"live"}));
});
