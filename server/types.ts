// Flexible JSON is used at the SQLite/provider boundary; public domain objects are typed.
export type Json = Record<string, any>;
export interface FieldIssue {
  stage: "parse" | "schema" | "grounding";
  path: string;
  rule: string;
  expected?: "string" | "object" | "array" | "integer" | "number" | "boolean" | "null";
  limit?: number;
}
export interface ResponseDiagnostics {
  issues: FieldIssue[];
  generation_id?: string;
  attempts?: number;
  max_attempts?: number;
  draft_saved?: boolean;
}
export interface Company extends Json {
  id: string;
  name: string;
  industry: string;
  region: string;
  revenue: number;
  products: string[];
  foreign_trade: boolean;
  top_partners: Json[];
  data_notes: string[];
}
export interface News extends Json {
  id: string;
  title: string;
  text: string;
  url: string;
  published: string;
  tags: string[];
  is_demo: boolean;
}
export interface Source extends Json {
  id: string;
  kind: "company" | "news" | "bank";
  title: string;
  text: string;
}
export interface Claim {
  kind: "fact" | "bank" | "ai";
  text: string;
  quote: string;
  source_ids: string[];
}
export interface Analysis extends Json {
  id: string;
  company_id: string;
  news_id: string;
  mode: string;
  summary: string;
  why_relevant: string;
  claims: Claim[];
  risks: string[];
  opportunities: string[];
  actions: string[];
  limitations: string[];
  sources: Source[];
  trace: Json[];
  cached: boolean;
}
export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export class ModelError extends AppError {
  constructor(message: string, public code = "MODEL_RESPONSE_INVALID", status = 502,
    public diagnostics?: ResponseDiagnostics) {
    super(message, status);
  }
}
