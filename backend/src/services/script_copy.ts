import { db } from '../db/database';
import { remapScriptDocumentCharacters, remapScriptSourceSnapshot, remapShotSpecScriptId } from '../schemas/script';

/** Run after all destination identities exist; never regenerate historical sources. */
export async function remapCopiedScriptChanges(maps: {
  scripts: Map<number, number>;
  characters: Map<number, number>;
  chapters: Map<string, string>;
  scenes: Map<string, number>;
}, destinationScriptIds: number[]) {
  const remapJson = (raw: string | null, chapterId: string, snapshot = false): string | null => {
    if (!raw) return raw;
    let value: any;
    try { value = JSON.parse(raw); } catch { return raw; }
    if (!value || typeof value !== 'object') return raw;
    if (snapshot) return JSON.stringify(remapScriptSourceSnapshot(value, chapterId, maps.characters));
    value = remapScriptDocumentCharacters(value, maps.characters);
    if (typeof value.scriptId === 'number') value.scriptId = maps.scripts.get(value.scriptId) ?? value.scriptId;
    if (typeof value.chapterId === 'string') value.chapterId = maps.chapters.get(value.chapterId) ?? chapterId;
    if (Array.isArray(value.scene_ids)) {
      value.scene_ids = value.scene_ids.map((id: number) => maps.scenes.get(String(id))).filter((id: unknown) => id !== undefined);
    }
    if (Array.isArray(value.shots)) {
      for (const shot of value.shots) {
        shot.shot_spec = remapShotSpecScriptId(shot.shot_spec, maps.scripts);
        if (shot.source?.type === 'script') {
          shot.source.script_id = maps.scripts.get(shot.source.script_id) ?? shot.source.script_id;
        }
      }
    }
    return JSON.stringify(value);
  };
  for (const scriptId of destinationScriptIds) {
    const script = await db.get('SELECT chapter_id FROM chapter_script WHERE id = ?', scriptId);
    const changes = await db.all('SELECT * FROM script_change WHERE script_id = ?', scriptId);
    for (const change of changes) {
      await db.run(
        `UPDATE script_change SET before_json = ?, after_json = ?, source_snapshot_json = ?, result_json = ? WHERE id = ?`,
        remapJson(change.before_json, script.chapter_id),
        remapJson(change.after_json, script.chapter_id),
        remapJson(change.source_snapshot_json, script.chapter_id, true),
        remapJson(change.result_json, script.chapter_id), change.id
      );
    }
  }
}
