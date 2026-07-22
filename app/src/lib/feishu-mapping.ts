/**
 * A proposal generator, not an importer. Chinese labels are used only once to
 * suggest a field ID mapping from discovered metadata; the returned mapping
 * contains source IDs only and must be approved before any data is applied.
 */

export interface FeishuFieldMetadata {
  fieldId: string;
  name: string;
}

export interface FeishuTableMetadata {
  tableId: string;
  name: string;
  fields: FeishuFieldMetadata[];
}

type Entity = 'people' | 'subscriptions';

export interface SourceEntityMapping {
  tableId: string;
  fieldIds: Record<string, string>;
}

export type MappingDiagnostic =
  | { kind: 'missing_table'; entity: Entity; candidateNames: string[] }
  | { kind: 'ambiguous_table'; entity: Entity; tableIds: string[] }
  | { kind: 'missing_required_field'; entity: Entity; fieldKey: string; candidateNames: string[] }
  | { kind: 'missing_optional_field'; entity: Entity; fieldKey: string; candidateNames: string[] }
  | { kind: 'ambiguous_field'; entity: Entity; tableId: string; fieldKey: string; fieldIds: string[] }
  | { kind: 'unknown_field'; tableId: string; fieldId: string };

export interface FeishuMappingProposal {
  status: 'pending_approval' | 'not_ready';
  mappings: {
    people?: SourceEntityMapping;
    subscriptions?: SourceEntityMapping;
  };
  diagnostics: {
    readiness: 'ready' | 'not_ready';
    included: Array<{ entity: Entity; tableId: string; fieldKey: string; fieldId: string }>;
    missing: MappingDiagnostic[];
    unknown: MappingDiagnostic[];
  };
}

interface EntityRule {
  entity: Entity;
  tableNames: string[];
  fields: Array<{ key: string; names: string[]; required: boolean }>;
}

const RULES: EntityRule[] = [
  {
    entity: 'people',
    tableNames: ['人员账号、邮箱管理'],
    fields: [
      { key: 'person', names: ['人员'], required: true },
      { key: 'privateEmail', names: ['个人私有邮箱'], required: false },
      { key: 'mobile', names: ['手机号'], required: false },
      { key: 'leadsHunterUsername', names: ['leadsHunter 用户名'], required: false },
      { key: 'githubEmail', names: ['github 邮箱账号'], required: false },
      { key: 'githubId', names: ['github_ID'], required: false },
      { key: 'lanCloudDomainEmail', names: ['兰芯域名邮箱'], required: false },
    ],
  },
  {
    entity: 'subscriptions',
    tableNames: ['资产订阅'],
    fields: [
      { key: 'subscriptionName', names: ['订阅项目名称'], required: true },
      { key: 'startDate', names: ['订阅开始日期'], required: true },
      { key: 'billingCycle', names: ['订阅周期'], required: true },
      { key: 'currency', names: ['订阅币种'], required: true },
      { key: 'amount', names: ['订阅总价（不换算与币种保持一致）'], required: true },
      { key: 'payer', names: ['付款者'], required: true },
      { key: 'subscriber', names: ['订阅者'], required: false },
      { key: 'autoRenew', names: ['是否自动续费'], required: false },
      { key: 'paymentMethod', names: ['付款方式'], required: false },
      { key: 'notes', names: ['备注'], required: false },
      { key: 'invoice', names: ['发票（可选）'], required: false },
    ],
  },
];

function tableMatches(rule: EntityRule, table: FeishuTableMetadata): boolean {
  return rule.tableNames.includes(table.name);
}

/**
 * Produces no values from source records. `mappings` contains only stable
 * table/field IDs so renaming a label cannot silently redirect a future import.
 */
export function proposeFeishuFieldMapping(tables: FeishuTableMetadata[]): FeishuMappingProposal {
  const included: FeishuMappingProposal['diagnostics']['included'] = [];
  const missing: MappingDiagnostic[] = [];
  const unknown: MappingDiagnostic[] = [];
  const mappings: FeishuMappingProposal['mappings'] = {};

  for (const rule of RULES) {
    const candidates = tables.filter((table) => tableMatches(rule, table));
    if (candidates.length === 0) {
      missing.push({ kind: 'missing_table', entity: rule.entity, candidateNames: rule.tableNames });
      continue;
    }
    if (candidates.length > 1) {
      missing.push({ kind: 'ambiguous_table', entity: rule.entity, tableIds: candidates.map((table) => table.tableId).sort() });
      continue;
    }
    const table = candidates[0]!;
    const fieldIds: Record<string, string> = {};
    const usedFieldIds = new Set<string>();
    for (const fieldRule of rule.fields) {
      const fieldCandidates = table.fields.filter((field) => fieldRule.names.includes(field.name));
      if (fieldCandidates.length === 1) {
        const field = fieldCandidates[0]!;
        fieldIds[fieldRule.key] = field.fieldId;
        usedFieldIds.add(field.fieldId);
        included.push({ entity: rule.entity, tableId: table.tableId, fieldKey: fieldRule.key, fieldId: field.fieldId });
        continue;
      }
      if (fieldCandidates.length > 1) {
        unknown.push({
          kind: 'ambiguous_field',
          entity: rule.entity,
          tableId: table.tableId,
          fieldKey: fieldRule.key,
          fieldIds: fieldCandidates.map((field) => field.fieldId).sort(),
        });
        continue;
      }
      const diagnostic: MappingDiagnostic = fieldRule.required
        ? { kind: 'missing_required_field', entity: rule.entity, fieldKey: fieldRule.key, candidateNames: fieldRule.names }
        : { kind: 'missing_optional_field', entity: rule.entity, fieldKey: fieldRule.key, candidateNames: fieldRule.names };
      (fieldRule.required ? missing : unknown).push(diagnostic);
    }
    for (const field of table.fields) {
      if (!usedFieldIds.has(field.fieldId)) {
        unknown.push({ kind: 'unknown_field', tableId: table.tableId, fieldId: field.fieldId });
      }
    }
    mappings[rule.entity] = { tableId: table.tableId, fieldIds };
  }

  const readiness = missing.some((diagnostic) =>
    diagnostic.kind === 'missing_table' ||
    diagnostic.kind === 'ambiguous_table' ||
    diagnostic.kind === 'missing_required_field',
  ) || unknown.some((diagnostic) => diagnostic.kind === 'ambiguous_field')
    ? 'not_ready'
    : 'ready';
  return {
    status: readiness === 'ready' ? 'pending_approval' : 'not_ready',
    mappings,
    diagnostics: { readiness, included, missing, unknown },
  };
}
