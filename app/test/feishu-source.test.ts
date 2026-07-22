import { describe, expect, it, vi } from 'vitest';
import {
  FeishuBaseReader,
  assertFeishuReadOnlyRequest,
  isFeishuImportConfigured,
  type FeishuSourceConfig,
} from '../src/lib/feishu-source';

const config: FeishuSourceConfig = {
  enabled: true,
  appId: 'app-id',
  appSecret: 'app-secret',
  baseToken: 'base-token',
  apiBaseUrl: 'https://open.feishu.cn',
};

describe('FeishuBaseReader', () => {
  it('默认禁用时不发起网络请求', async () => {
    const fetcher = vi.fn();
    expect(isFeishuImportConfigured({ ...config, enabled: false })).toBe(false);
    await expect(new FeishuBaseReader({ ...config, enabled: false }, fetcher).listTables()).rejects.toThrow(/disabled/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('只允许拿 token 的 POST，其余 tables、fields、records 全部 GET 且保留 ID / 分页', async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ url, method });
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return Response.json({ code: 0, tenant_access_token: 'sensitive-token', expire: 7200 });
      }
      if (url.includes('/tables?')) {
        return Response.json({ code: 0, data: { items: [{ table_id: 'tbl-a', name: '订阅' }], has_more: false } });
      }
      if (url.includes('/fields?')) {
        return Response.json({ code: 0, data: { items: [{ field_id: 'fld-a', field_name: '订阅项目名称', type: 1 }], has_more: false } });
      }
      if (url.includes('/records?') && !url.includes('page_token=next')) {
        return Response.json({ code: 0, data: { items: [{ record_id: 'rec-1', fields: { '订阅项目名称': 'Example' } }], has_more: true, page_token: 'next' } });
      }
      if (url.includes('/records?') && url.includes('page_token=next')) {
        return Response.json({ code: 0, data: { items: [{ record_id: 'rec-2', fields: {} }], has_more: false } });
      }
      return new Response('not found', { status: 404 });
    });
    const reader = new FeishuBaseReader(config, fetcher);

    expect(await reader.listTables()).toEqual([{ tableId: 'tbl-a', name: '订阅' }]);
    expect(await reader.listFields('tbl-a')).toEqual([{ fieldId: 'fld-a', name: '订阅项目名称', type: 1 }]);
    expect((await reader.listRecords('tbl-a')).map((record) => record.recordId)).toEqual(['rec-1', 'rec-2']);
    expect(requests).toHaveLength(5);
    expect(requests.filter((request) => !request.url.includes('/auth/v3/tenant_access_token/internal')).every((request) => request.method === 'GET')).toBe(true);
    expect(JSON.stringify(await reader.listTables())).not.toContain('sensitive-token');
  });
});

describe('assertFeishuReadOnlyRequest', () => {
  it('拒绝对 Base 业务端点的任何非 GET 请求', () => {
    expect(() => assertFeishuReadOnlyRequest('POST', 'https://open.feishu.cn/open-apis/bitable/v1/apps/x/tables')).toThrow();
    expect(() => assertFeishuReadOnlyRequest('DELETE', 'https://open.feishu.cn/open-apis/bitable/v1/apps/x/tables/y/records/z')).toThrow();
    expect(() => assertFeishuReadOnlyRequest('GET', 'https://open.feishu.cn/open-apis/bitable/v1/apps/x/tables')).not.toThrow();
  });
});
