import type { ContinuityEntity } from '../schemas/continuity';

export const continuityPropertyLabels: Record<string, string> = { color: '颜色', wetness: '湿度', integrity: '完整度', wearer: '穿戴者', holder: '持有者', owner: '所有者', location: '所在地点', presence: '在场状态', open_state: '开闭', lock_function: '锁功能', power_state: '电源' };
const values: Record<string, string> = { dry: '干燥', wet: '湿透', intact: '完好', damaged: '受损', broken: '损坏', present: '在场', absent: '离场', open: '开启', closed: '关闭', working: '正常', on: '开启', off: '关闭' };
export type ContinuityVisualState = {
  entity: string; entity_id: string; entity_kind: ContinuityEntity['kind']; parent_entity_id?: string;
  design_asset_id?: number; design_asset_revision?: number;
  attribute: string; value: string; canonical_value: unknown; target_entity_id?: string; target_name?: string;
  fact_id: string;
};

/** Compile selected confirmed cells only. Designs never fill missing story values. */
export function continuityVisualStates(entities: readonly ContinuityEntity[], cells: readonly { entity_id: string; attribute_id: string; knowledge_status: string; value?: unknown }[], snapshotId: string): ContinuityVisualState[] {
  return cells.flatMap(cell => {
    if (cell.knowledge_status !== 'confirmed') return [];
    if (cell.value === undefined) throw new Error('Confirmed visual state has no value');
    const entity = entities.find(entity => entity.entity_id === cell.entity_id);
    if (!entity) throw new Error('Confirmed visual state has an unknown physical entity');
    const target = entities.find(entity => entity.entity_id === cell.value);
    return [{ entity: entity.display_name, entity_id: entity.entity_id, entity_kind: entity.kind,
      ...(entity.asset_id ? { design_asset_id: entity.asset_id, design_asset_revision: entity.asset_revision } : {}),
      ...(entity.parent_entity_id ? { parent_entity_id: entity.parent_entity_id } : {}), attribute: cell.attribute_id,
      value: cell.value === null ? 'none' : target?.display_name || (typeof cell.value === 'string' ? cell.value : JSON.stringify(cell.value)),
      canonical_value: cell.value, ...(target ? { target_entity_id: target.entity_id, target_name: target.display_name } : {}),
      fact_id: `confirmed:${snapshotId}:${entity.entity_id}:${cell.attribute_id}` }];
  });
}
export function continuityVisualFact(state: ContinuityVisualState) {
  if(state.attribute==='holding_hand'){
    const hand=({physical_left:'anatomical left hand',physical_right:'anatomical right hand',both:'both anatomical hands',unheld:'not held in any hand'} as Record<string,string>)[String(state.canonical_value)];
    if(!hand)throw new Error('Unknown physical hand state');return `${state.entity} [${state.entity_id}]: current holder uses ${hand}; physical handedness is independent of screen left/right`;
  }
  const value = state.canonical_value === null ? '明确无此关系' : state.target_name || (typeof state.canonical_value === 'string' ? values[state.canonical_value] : '') || state.value;
  return `${state.entity} [${state.entity_id}]${state.parent_entity_id ? `（组件所属 ${state.parent_entity_id}）` : ''}：${continuityPropertyLabels[state.attribute] || state.attribute}=${value}${state.target_entity_id ? ` [${state.target_entity_id}]` : ''}`;
}
/** Wardrobe defaults apply only when no explicitly tracked garment is tied to that person. */
export function charactersWithConfirmedWardrobe(states: readonly ContinuityVisualState[]) {
  const garments = new Set(states.filter(state => state.entity_kind === 'garment').map(state => state.entity_id));
  const names = new Set<string>();
  for (const id of garments) {
    const wearer = states.find(state => state.entity_id === id && state.attribute === 'wearer');
    if (wearer?.target_name) names.add(wearer.target_name);
    else if (wearer?.canonical_value === null) {
      const owner = states.find(state => state.entity_id === id && state.attribute === 'owner');
      if (owner?.target_name) names.add(owner.target_name);
    }
  }
  return names;
}
