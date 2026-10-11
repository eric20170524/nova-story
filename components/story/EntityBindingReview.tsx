import React from 'react';
import type { EntityBinding, EntityRef } from '../../backend/src/schemas/entity_binding';

export function EntityBindingReview({ binding, characters, onChange }: { binding: EntityBinding; characters?: EntityRef[]; onChange: (binding: EntityBinding) => void }) {
  const update = (index: number, patch: Partial<EntityBinding['mentions'][number]>) => onChange({ ...binding, mentions: binding.mentions.map((mention, i) => i === index ? { ...mention, ...patch, authority: 'human' } : mention) });
  return <div className="w-full space-y-1 text-xs">
    {binding.mentions.map((mention, index) => {
      const options = [...new Map([...(characters || mention.candidates), ...(mention.entity ? [mention.entity] : [])].map(entity => [entity.id, entity])).values()];
      return <div key={index} className="flex flex-wrap gap-2 items-center">
      <span>{mention.text || '省略的主语'} 对应人物{!mention.confirmed ? '（待核对）' : ''}</span>
      <select aria-label={`${mention.text || '省略的主语'}对应人物`} value={mention.entity?.id || ''} onChange={event => {
        const entity = options.find(e => e.id === event.target.value) || null;
        update(index, { entity, candidates: options, confirmed: Boolean(entity), status: entity ? 'resolved' : 'unknown', visibility: entity ? mention.visibility === 'uncertain' ? 'visible' : mention.visibility : 'uncertain' });
      }} className="rounded border p-1 bg-white dark:bg-slate-900">
        <option value="">待核对</option>{options.map(entity => <option key={entity.id} value={entity.id}>{entity.name}</option>)}
      </select>
      <select aria-label={`${mention.text || '省略的主语'}是否入镜`} value={mention.visibility} onChange={event => update(index, { visibility: event.target.value as typeof mention.visibility })} className="rounded border p-1 bg-white dark:bg-slate-900">
        <option value="visible">人物本人入镜</option><option value="mentioned">仅被提及／照片／画外</option><option value="uncertain">入镜待核对</option>
      </select>
    </div>; })}
  </div>;
}
