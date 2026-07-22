import { describe, expect, it } from 'vitest';
import * as ui from '../src/ui';

describe('identity settings and external binding UI', () => {
  it('declares the caller-scoped identity API contract instead of bootstrap', () => {
    expect(ui.UI_PAGES).toContain('profile');
    expect(ui.UI_API_CONTRACT).toMatchObject({
      identities: '/api/me/identities',
      beginIdentityLink: '/api/me/identities/link-transactions',
      resumableIdentityLinks: '/api/me/identities/link-transactions/recovery',
      confirmIdentityLink: '/api/me/identities/link-transactions/:id/confirm',
      revokeIdentity: '/api/me/identities/:id',
      presentExternalIdentity: '/api/external/identity-presentations',
    });
    expect(ui.UI_API_CONTRACT).not.toHaveProperty('bootstrap');
    expect(ui).toHaveProperty('renderExternalIdentityUi');
  });

  it('renders a corporate profile with identity-link controls and no bootstrap panel', () => {
    const html = ui.renderAdminUi({
      page: 'profile',
      principal: { displayName: 'employee@lancloudtech.com', roles: ['employee'] },
    });

    expect(html).toContain('登录身份');
    expect(html).toContain('企业主身份（不可解绑）');
    expect(html).toContain('绑定 Cloudflare');
    expect(html).toContain('绑定 GitHub');
    expect(html).toContain('data-action="begin-identity-link"');
    expect(html).toContain('待恢复的外部绑定');
    expect(html).toContain('identity-link-recovery');
    expect(html).toContain('api.resumableIdentityLinks');
    expect(html).toContain("transaction.status === 'candidate_presented'");
    expect(html).toContain('继续确认绑定');
    expect(html).not.toContain('bootstrap-admin');
    expect(html).not.toContain('/api/bootstrap');
  });

  it('renders the external entry as a data-free binding-code page', () => {
    const renderer = (ui as Record<string, unknown>).renderExternalIdentityUi;
    expect(renderer).toBeTypeOf('function');
    const html = (renderer as () => string)();

    expect(html).toContain('输入绑定码');
    expect(html).toContain('/api/external/identity-presentations');
    expect(html).not.toContain('订阅资产');
    expect(html).not.toContain('报销中心');
    expect(html).not.toContain('<nav');
    expect(html).not.toContain('bootstrap-admin');
  });

  it('renders a data-free external Access-login-required page without a binding form', () => {
    const renderer = (ui as Record<string, unknown>).renderExternalAccessRequiredUi;
    expect(renderer).toBeTypeOf('function');
    const html = (renderer as () => string)();

    expect(html).toContain('需要外部 Access 登录');
    expect(html).not.toContain('external-binding-form');
    expect(html).not.toContain('输入绑定码');
    expect(html).not.toContain('/api/external/identity-presentations');
    expect(html).not.toContain('订阅资产');
  });

  it('keeps employee navigation and dashboard actions within personal scope', () => {
    const html = ui.renderAdminUi({
      page: 'dashboard',
      principal: { displayName: 'employee@lancloudtech.com', roles: ['employee'] },
    });
    const navigation = html.match(/<nav>([\s\S]*?)<\/nav>/)?.[1] ?? '';

    expect(navigation).toContain('总览');
    expect(navigation).toContain('订阅资产');
    expect(navigation).toContain('账号资产');
    expect(navigation).toContain('个人设置');
    expect(navigation).not.toContain('报销中心');
    expect(navigation).not.toContain('汇率');
    expect(navigation).not.toContain('人员与权限');
    expect(navigation).not.toContain('导入与审计');
    expect(html).not.toContain('预览飞书导入');
    expect(html).not.toContain('维护订阅条款');
    expect(html).not.toContain('生成报销草稿');
    expect(html).not.toContain('/api/reimbursements');
    expect(html).not.toContain('/api/exchange-rates');
  });

  it('keeps generated binding codes out of the corporate profile DOM and copies only on a user gesture', () => {
    const html = ui.renderAdminUi({
      page: 'profile',
      principal: { displayName: 'employee@lancloudtech.com', roles: ['employee'] },
    });

    expect(html).toContain("copy.textContent = '复制绑定码'");
    expect(html).toContain("copy.addEventListener('click', async () => {");
    expect(html).toContain('navigator.clipboard.writeText(code)');
    expect(html).toContain('externalLink.href = externalUrl');
    expect(html).not.toContain("document.createElement('code')");
    expect(html).not.toContain('codeEl.textContent');
    expect(html).not.toMatch(/(?:textContent|innerHTML|href|value|ariaLabel)\s*=\s*code\b/);
    expect(html).not.toMatch(/setAttribute\([^,]+,\s*code\b/);
    expect(html).not.toMatch(/(?:setIdentityResult|toast|console\.(?:log|warn|error|info))\([^)]*\bcode\b/);
    expect(html).toContain('api.confirmIdentityLink.replace');
    expect(html).toContain("method: 'DELETE'");
    expect(html).toContain("credentials: 'same-origin'");
    expect(html).not.toContain('binding-result.innerHTML');
  });

  it('uses a masked one-time-code field at the external entry', () => {
    const renderer = (ui as Record<string, unknown>).renderExternalIdentityUi;
    const html = (renderer as () => string)();

    expect(html).toContain('<label for="external-binding-code">绑定码');
    expect(html).toContain('id="external-binding-code" name="code" type="password" autocomplete="one-time-code"');
    expect(html).not.toMatch(/<input[^>]*name="code"(?![^>]*type="password")/);
    expect(html).not.toMatch(/setResult\([^)]*\bcode\b/);
  });

  it('keeps external presentation failures opaque while identifying only an Access re-login requirement', () => {
    const renderer = (ui as Record<string, unknown>).renderExternalIdentityUi;
    const html = (renderer as () => string)();

    expect(html).toContain('if (response.status === 401)');
    expect(html).toContain("setResult('请先完成外部 Access 登录后重试。', 'error')");
    expect(html).toContain("if (!response.ok) throw new Error('rejected')");
    expect(html).not.toMatch(/setResult\([^)]*(?:response\.status|response\.statusText|await response\.text)/);
  });

  it('does not render restricted forms when an employee follows a restricted UI URL directly', () => {
    const html = ui.renderAdminUi({
      page: 'reimbursements',
      principal: { displayName: 'employee@lancloudtech.com', roles: ['employee'] },
    });

    expect(html).toContain('<h1>管理总览</h1>');
    expect(html).not.toContain('<button class="button primary" type="button" data-action="create-reimbursement"');
    expect(html).not.toContain('<form data-api="fx-quotes"');
  });
});
