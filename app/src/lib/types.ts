// 兰芯云朵行政——订阅资产管理系统 · 共享类型定义
// 注意：本系统不存密码 / OTP / token / 完整卡号。

export interface Env {
  DB: D1Database;
  RECEIPTS_BUCKET?: R2Bucket;
  ENVIRONMENT: string;
  DEV_AUTH?: string;
  ACCESS_AUD_CORPORATE?: string;
  ACCESS_AUD_EXTERNAL?: string;
  ACCESS_ISSUER?: string;
  ACCESS_JWKS_URL?: string;
  APP_ORIGINS?: string;
  MIGRATION_SYSTEM_ADMIN_EMAIL?: string;
  FX_PROVIDER?: string;
  FX_API_KEY?: string;
  FX_PROVIDER_URL?: string;
  FX_CURRENCIES?: string;
  FEISHU_IMPORT_ENABLED?: string;
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  FEISHU_BASE_TOKEN?: string;
  FEISHU_API_BASE_URL?: string;
  FEISHU_PERSON_TABLE_ID?: string;
  FEISHU_SUBSCRIPTION_TABLE_ID?: string;
}
