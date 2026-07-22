import { describe, expect, it } from 'vitest';
import { proposeFeishuFieldMapping, type FeishuTableMetadata } from '../src/lib/feishu-mapping';

const completeMetadata: FeishuTableMetadata[] = [
  {
    tableId: 'tbl-people-source',
    name: '人员账号、邮箱管理',
    fields: [
      { fieldId: 'fld-person', name: '人员' },
      { fieldId: 'fld-private-email', name: '个人私有邮箱' },
      { fieldId: 'fld-mobile', name: '手机号' },
      { fieldId: 'fld-leads-hunter', name: 'leadsHunter 用户名' },
      { fieldId: 'fld-github-email', name: 'github 邮箱账号' },
      { fieldId: 'fld-github-id', name: 'github_ID' },
      { fieldId: 'fld-domain-email', name: '兰芯域名邮箱' },
      { fieldId: 'fld-legacy-id', name: '账号资产 ID' },
    ],
  },
  {
    tableId: 'tbl-subscription-source',
    name: '资产订阅',
    fields: [
      { fieldId: 'fld-name', name: '订阅项目名称' },
      { fieldId: 'fld-start', name: '订阅开始日期' },
      { fieldId: 'fld-cycle', name: '订阅周期' },
      { fieldId: 'fld-currency', name: '订阅币种' },
      { fieldId: 'fld-amount', name: '订阅总价（不换算与币种保持一致）' },
      { fieldId: 'fld-payer', name: '付款者' },
      { fieldId: 'fld-subscriber', name: '订阅者' },
      { fieldId: 'fld-auto-renew', name: '是否自动续费' },
      { fieldId: 'fld-payment-method', name: '付款方式' },
      { fieldId: 'fld-notes', name: '备注' },
      { fieldId: 'fld-invoice', name: '发票（可选）' },
      { fieldId: 'fld-legacy-id', name: '订阅 ID' },
    ],
  },
];

describe('proposeFeishuFieldMapping', () => {
  it('仅以元数据中的 tableId / fieldId 生成待审批映射，中文名只用于预览匹配', () => {
    const proposal = proposeFeishuFieldMapping(completeMetadata);

    expect(proposal.status).toBe('pending_approval');
    expect(proposal.diagnostics.readiness).toBe('ready');
    expect(proposal.mappings).toEqual({
      people: {
        tableId: 'tbl-people-source',
        fieldIds: {
          person: 'fld-person',
          privateEmail: 'fld-private-email',
          mobile: 'fld-mobile',
          leadsHunterUsername: 'fld-leads-hunter',
          githubEmail: 'fld-github-email',
          githubId: 'fld-github-id',
          lanCloudDomainEmail: 'fld-domain-email',
        },
      },
      subscriptions: {
        tableId: 'tbl-subscription-source',
        fieldIds: {
          subscriptionName: 'fld-name',
          startDate: 'fld-start',
          billingCycle: 'fld-cycle',
          currency: 'fld-currency',
          amount: 'fld-amount',
          payer: 'fld-payer',
          subscriber: 'fld-subscriber',
          autoRenew: 'fld-auto-renew',
          paymentMethod: 'fld-payment-method',
          notes: 'fld-notes',
          invoice: 'fld-invoice',
        },
      },
    });
    expect(proposal.diagnostics.included).toHaveLength(18);
    expect(proposal.diagnostics.unknown).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'unknown_field', tableId: 'tbl-people-source', fieldId: 'fld-legacy-id' }),
      expect.objectContaining({ kind: 'unknown_field', tableId: 'tbl-subscription-source', fieldId: 'fld-legacy-id' }),
    ]));
    expect(JSON.stringify(proposal.mappings)).not.toContain('订阅项目名称');
    expect(JSON.stringify(proposal.mappings)).not.toContain('人员账号、邮箱管理');
  });

  it('来源表缺失或必需字段缺失时标记 not_ready，并保留可审批的部分 ID 映射', () => {
    const noTables = proposeFeishuFieldMapping([]);
    expect(noTables.status).toBe('not_ready');
    expect(noTables.diagnostics.readiness).toBe('not_ready');
    expect(noTables.diagnostics.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'missing_table', entity: 'people' }),
      expect.objectContaining({ kind: 'missing_table', entity: 'subscriptions' }),
    ]));

    const missingPayer = proposeFeishuFieldMapping([
      completeMetadata[0]!,
      {
        ...completeMetadata[1]!,
        fields: completeMetadata[1]!.fields.filter((field) => field.fieldId !== 'fld-payer'),
      },
    ]);
    expect(missingPayer.status).toBe('not_ready');
    expect(missingPayer.mappings.subscriptions?.fieldIds.payer).toBeUndefined();
    expect(missingPayer.diagnostics.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'missing_required_field',
        entity: 'subscriptions',
        fieldKey: 'payer',
        candidateNames: ['付款者'],
      }),
    ]));
  });

  it('同一候选字段名对应多个 fieldId 时拒绝猜测，直到人工审批消除歧义', () => {
    const duplicatePayer = proposeFeishuFieldMapping([
      completeMetadata[0]!,
      {
        ...completeMetadata[1]!,
        fields: [
          ...completeMetadata[1]!.fields,
          { fieldId: 'fld-payer-copy', name: '付款者' },
        ],
      },
    ]);

    expect(duplicatePayer.status).toBe('not_ready');
    expect(duplicatePayer.mappings.subscriptions?.fieldIds.payer).toBeUndefined();
    expect(duplicatePayer.diagnostics.unknown).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'ambiguous_field',
        entity: 'subscriptions',
        tableId: 'tbl-subscription-source',
        fieldKey: 'payer',
        fieldIds: ['fld-payer', 'fld-payer-copy'],
      }),
    ]));
  });
});
