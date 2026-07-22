import type { Env } from './types';

/** A deliberately small, read-only adapter for Feishu Base. */
export interface FeishuSourceConfig {
  enabled: boolean;
  appId?: string;
  appSecret?: string;
  baseToken?: string;
  apiBaseUrl?: string;
}

export interface FeishuTable {
  tableId: string;
  name: string;
}

export interface FeishuField {
  fieldId: string;
  name: string;
  type: number | string;
}

export interface FeishuRecord {
  recordId: string;
  fields: Record<string, unknown>;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const TENANT_TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal';
const BITABLE_PATH_PREFIX = '/open-apis/bitable/v1/apps/';

function cleanBaseUrl(value: string | undefined): string {
  return (value ?? 'https://open.feishu.cn').replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Does not return configuration values, so callers cannot accidentally log secrets. */
export function isFeishuImportConfigured(config: FeishuSourceConfig): boolean {
  return config.enabled && Boolean(config.appId && config.appSecret && config.baseToken);
}

export function feishuSourceConfigFromEnv(env: Pick<Env,
  'FEISHU_IMPORT_ENABLED' | 'FEISHU_APP_ID' | 'FEISHU_APP_SECRET' | 'FEISHU_BASE_TOKEN' | 'FEISHU_API_BASE_URL'
>): FeishuSourceConfig {
  return {
    enabled: env.FEISHU_IMPORT_ENABLED === '1',
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    baseToken: env.FEISHU_BASE_TOKEN,
    apiBaseUrl: env.FEISHU_API_BASE_URL,
  };
}

/**
 * Business requests are GET-only. The sole POST exception is the Feishu
 * tenant access token endpoint; no create/update/delete Base route is exposed.
 */
export function assertFeishuReadOnlyRequest(method: string, url: string): void {
  const parsed = new URL(url);
  const normalizedMethod = method.toUpperCase();
  if (parsed.pathname === TENANT_TOKEN_PATH && normalizedMethod === 'POST') return;
  if (parsed.pathname.startsWith(BITABLE_PATH_PREFIX) && normalizedMethod === 'GET') return;
  throw new Error('Feishu source adapter only permits a tenant-token POST and Base GET requests');
}

function asItems(payload: unknown): { items: unknown[]; hasMore: boolean; pageToken?: string } {
  if (!isRecord(payload) || payload.code !== 0 || !isRecord(payload.data) || !Array.isArray(payload.data.items)) {
    throw new Error('Feishu source response is invalid');
  }
  const pageToken = typeof payload.data.page_token === 'string' ? payload.data.page_token : undefined;
  return {
    items: payload.data.items,
    hasMore: payload.data.has_more === true,
    ...(pageToken ? { pageToken } : {}),
  };
}

export class FeishuBaseReader {
  private tenantAccessToken: string | null = null;

  constructor(
    private readonly config: FeishuSourceConfig,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  private requireConfigured(): { appId: string; appSecret: string; baseToken: string } {
    if (!isFeishuImportConfigured(this.config)) {
      throw new Error('Feishu import is disabled or incomplete');
    }
    return {
      appId: this.config.appId!,
      appSecret: this.config.appSecret!,
      baseToken: this.config.baseToken!,
    };
  }

  private async accessToken(): Promise<string> {
    if (this.tenantAccessToken) return this.tenantAccessToken;
    const config = this.requireConfigured();
    const url = `${cleanBaseUrl(this.config.apiBaseUrl)}${TENANT_TOKEN_PATH}`;
    assertFeishuReadOnlyRequest('POST', url);
    const response = await this.fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
    });
    if (!response.ok) throw new Error('unable to authenticate Feishu source');
    const payload = await response.json() as unknown;
    if (!isRecord(payload) || payload.code !== 0 || typeof payload.tenant_access_token !== 'string') {
      throw new Error('unable to authenticate Feishu source');
    }
    this.tenantAccessToken = payload.tenant_access_token;
    return this.tenantAccessToken;
  }

  private async get(path: string): Promise<unknown> {
    const token = await this.accessToken();
    const url = `${cleanBaseUrl(this.config.apiBaseUrl)}${path}`;
    assertFeishuReadOnlyRequest('GET', url);
    const response = await this.fetcher(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('unable to read Feishu source');
    return response.json() as Promise<unknown>;
  }

  private async allPages<T>(
    path: string,
    pageSize: number,
    mapper: (item: unknown) => T | null,
  ): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 1_000; page += 1) {
      const params = new URLSearchParams({ page_size: String(pageSize) });
      if (pageToken) params.set('page_token', pageToken);
      const payload = await this.get(`${path}?${params.toString()}`);
      const listed = asItems(payload);
      for (const item of listed.items) {
        const mapped = mapper(item);
        if (mapped) items.push(mapped);
      }
      if (!listed.hasMore) return items;
      if (!listed.pageToken) throw new Error('Feishu source pagination token is missing');
      pageToken = listed.pageToken;
    }
    throw new Error('Feishu source pagination exceeded limit');
  }

  async listTables(): Promise<FeishuTable[]> {
    const { baseToken } = this.requireConfigured();
    return this.allPages(`${BITABLE_PATH_PREFIX}${encodeURIComponent(baseToken)}/tables`, 100, (item) => {
      if (!isRecord(item) || typeof item.table_id !== 'string' || typeof item.name !== 'string') return null;
      return { tableId: item.table_id, name: item.name };
    });
  }

  async listFields(tableId: string): Promise<FeishuField[]> {
    const { baseToken } = this.requireConfigured();
    if (!tableId) throw new Error('tableId is required');
    return this.allPages(
      `${BITABLE_PATH_PREFIX}${encodeURIComponent(baseToken)}/tables/${encodeURIComponent(tableId)}/fields`,
      100,
      (item) => {
        if (!isRecord(item) || typeof item.field_id !== 'string' || typeof item.field_name !== 'string') return null;
        if (typeof item.type !== 'number' && typeof item.type !== 'string') return null;
        return { fieldId: item.field_id, name: item.field_name, type: item.type };
      },
    );
  }

  async listRecords(tableId: string): Promise<FeishuRecord[]> {
    const { baseToken } = this.requireConfigured();
    if (!tableId) throw new Error('tableId is required');
    return this.allPages(
      `${BITABLE_PATH_PREFIX}${encodeURIComponent(baseToken)}/tables/${encodeURIComponent(tableId)}/records`,
      500,
      (item) => {
        if (!isRecord(item) || typeof item.record_id !== 'string' || !isRecord(item.fields)) return null;
        return { recordId: item.record_id, fields: item.fields };
      },
    );
  }

  /** Discovery intentionally exposes metadata and record IDs only to the caller's mapping layer. */
  async discover(tableIds?: string[]): Promise<Array<{ table: FeishuTable; fields: FeishuField[]; recordCount: number }>> {
    const tables = await this.listTables();
    const targets = tableIds?.length ? tables.filter((table) => tableIds.includes(table.tableId)) : tables;
    const discovered: Array<{ table: FeishuTable; fields: FeishuField[]; recordCount: number }> = [];
    for (const table of targets) {
      const [fields, records] = await Promise.all([this.listFields(table.tableId), this.listRecords(table.tableId)]);
      discovered.push({ table, fields, recordCount: records.length });
    }
    return discovered;
  }
}
