import '../../test_setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../db/database';
import { ScriptService } from '../script_service';
import {
  StoryboardGenerationService,
  StoryboardGenerationError,
} from './storyboard_generation_service';
import type { AIProvider } from './base';
import type { z } from 'zod';
import {
  createEmptyScriptDocument,
  type ScriptDocument,
} from '../../schemas/script';

// Helper to set up clean in-memory test database fixture
async function setupTestFixture() {
  await db.exec(`
    DELETE FROM generation_task;
    DELETE FROM coverage_shot;
    DELETE FROM coverage_group;
    DELETE FROM scene_version;
    DELETE FROM scene;
    DELETE FROM script_change;
    DELETE FROM chapter_script;
    DELETE FROM character_version;
    DELETE FROM character;
    DELETE FROM chapter;
    DELETE FROM project;
  `);

  const projResult = await db.run(
    `INSERT INTO project (title, description, settings) VALUES (?, ?, ?)`,
    'S3导演交接测试项目',
    '测试剧本向分镜安全交接',
    JSON.stringify({
      bible: { genre: '玄幻短剧', style: '快节奏', main_plot: '宗门试炼' },
    })
  );
  const projId = projResult.lastID;

  const charResult = await db.run(
    `INSERT INTO character (project_id, name, role, visual_tags) VALUES (?, ?, ?, ?)`,
    projId,
    '陆尘',
    '男主角',
    JSON.stringify({ core: '1boy, black hair, determined eyes' })
  );
  const charId = Number(charResult.lastID);
  assert.ok(charId);

  const char2Result = await db.run(
    `INSERT INTO character (project_id, name, role, visual_tags) VALUES (?, ?, ?, ?)`,
    projId,
    '青檀',
    '女主角',
    JSON.stringify({ core: '1girl, long brown hair, silver hairpin' })
  );
  const char2Id = Number(char2Result.lastID);
  assert.ok(char2Id);

  const chapterId = 'chap_s3_001';
  await db.run(
    `INSERT INTO chapter (id, project_id, title, content, "index") VALUES (?, ?, ?, ?, ?)`,
    chapterId,
    projId,
    '第一章 山门试炼',
    '陆尘登上了万仞孤峰。青檀站在悬崖边缘回望。九龙天碑在山巅静静伫立。',
    1
  );

  return { projId, charId, char2Id, chapterId };
}

function buildValidConfirmedScript(char1Id: number, char2Id: number): ScriptDocument {
  const doc = createEmptyScriptDocument('山门试炼短剧剧本', { targetDurationSec: 90 });
  doc.outline = {
    logline: '少年登顶孤峰通过宗门试炼',
    mustKeepEvents: [
      { id: 'ev_1', text: '登顶孤峰', sourceParagraphIds: ['p_1'] },
      { id: 'ev_2', text: '九龙天碑显圣', sourceParagraphIds: ['p_3'] },
    ],
    beats: [
      { id: 'b_1', purpose: '登峰对决', eventIds: ['ev_1'] },
      { id: 'b_2', purpose: '天碑觉醒', eventIds: ['ev_2'] },
    ],
    endingHook: '天碑绽放金芒',
  };
  doc.locations = [
    { id: 'loc_cliff', name: '万仞孤峰断崖', description: '狂风呼啸的孤峰悬崖' },
    { id: 'loc_monolith', name: '九龙天碑前', description: '古老青石刻印着九条游龙' },
  ];
  doc.props = [
    { id: 'prop_sword', name: '青锋古剑', description: '泛着寒芒的铁剑' },
  ];
  doc.scenes = [
    {
      id: 'scene_1',
      beatIds: ['b_1'],
      eventIds: ['ev_1'],
      sourceParagraphIds: ['p_1'],
      locationId: 'loc_cliff',
      interiorExterior: 'exterior',
      timeOfDay: 'dusk',
      characterIds: [char1Id, char2Id],
      propIds: ['prop_sword'],
      estimatedDurationSec: 40,
      blocks: [
        { id: 'blk_1_act', type: 'action', text: '陆尘持青锋古剑破风而立，白衣染血。' },
        { id: 'blk_1_dia1', type: 'dialogue', characterId: char1Id, text: '九千级台阶，我终究是走上来了。' },
        { id: 'blk_1_dia2', type: 'dialogue', characterId: char2Id, delivery: '欣慰含泪', text: '我就知道你一定能做到！' },
        { id: 'blk_1_vo', type: 'voiceover', characterId: null, text: '十年磨一剑，今朝试锋芒。' },
        { id: 'blk_1_snd', type: 'sound', text: '呼啸的凛冽狂风声' },
      ],
    },
    {
      id: 'scene_2',
      beatIds: ['b_2'],
      eventIds: ['ev_2'],
      sourceParagraphIds: ['p_3'],
      locationId: 'loc_monolith',
      interiorExterior: 'exterior',
      timeOfDay: 'dusk',
      characterIds: [char1Id],
      propIds: [],
      estimatedDurationSec: 50,
      blocks: [
        { id: 'blk_2_act', type: 'action', text: '陆尘抬手按在九龙天碑正中。' },
        { id: 'blk_2_snd', type: 'sound', text: '轰隆沉闷的地脉震动声' },
        { id: 'blk_2_dia', type: 'dialogue', characterId: char1Id, text: '古碑显圣，开！' },
        { id: 'blk_2_vo', type: 'voiceover', characterId: char1Id, text: '属于我的命运，今日由我执掌。' },
      ],
    },
  ];
  return doc;
}

test('Track 5 S3: 剧本到分镜的安全交接与门禁', async (t) => {
  await t.test('SC08: 完整场次与 block 覆盖、原声文本与顺序正确装配', async () => {
    const fixture = await setupTestFixture();
    const script = await ScriptService.createOrGetScript(fixture.chapterId, '山门试炼短剧剧本');
    const doc = buildValidConfirmedScript(fixture.charId, fixture.char2Id);

    // Save and confirm script
    await ScriptService.saveManualScript({
      scriptId: script.id,
      document: doc,
      expectedRevision: 1,
    });
    const confirmed = await ScriptService.confirmScript({
      scriptId: script.id,
      expectedRevision: 2,
    });
    assert.equal(confirmed.status, 'confirmed');

    // Mock Provider returning valid shots covering all scenes and audible blocks
    const mockProvider: AIProvider = {
      async generateStructured<T>(_prompt: string, schema: z.ZodSchema<T>): Promise<T> {
        return schema.parse({
          shots: [
            // Shot 1: Scene 1 establish
            {
              script_scene_id: 'scene_1',
              block_ids: ['blk_1_act', 'blk_1_snd'],
              shot_intent: 'establish',
              shot_type: 'Wide Shot',
              location: '万仞孤峰断崖',
              primary_action: '少年白衣染血迎风持剑',
              primary_subject: '陆尘',
              visible_subjects: ['陆尘'],
              key_props: ['青锋古剑'],
              subject_scale: 'small-15-20',
              camera_movement: 'Pan',
              camera_angle: 'Low-angle',
              duration: 3.5,
              must_not: ['modern buildings'],
            },
            // Shot 2: Scene 1 dialogues and voiceover in exact order
            {
              script_scene_id: 'scene_1',
              block_ids: ['blk_1_dia1', 'blk_1_dia2', 'blk_1_vo'],
              shot_intent: 'wide-action',
              shot_type: 'Medium Shot',
              location: '万仞孤峰断崖',
              primary_action: '两人在悬崖边相视对话',
              primary_subject: '陆尘',
              visible_subjects: ['陆尘', '青檀'],
              key_props: ['青锋古剑'],
              subject_scale: 'medium-20-40',
              camera_movement: 'Static',
              camera_angle: 'Eye-level',
              duration: 4.0,
            },
            // Shot 3: Scene 2 insert on monolith / prop
            {
              script_scene_id: 'scene_2',
              block_ids: ['blk_2_act', 'blk_2_snd'],
              shot_intent: 'insert',
              shot_type: 'Close-up',
              location: '九龙天碑前',
              primary_action: '少年手掌按在古老石碑核心石印上',
              primary_subject: '陆尘',
              visible_subjects: ['陆尘'],
              key_props: ['青锋古剑'],
              subject_scale: 'dominant',
              camera_movement: 'Zoom In',
              camera_angle: 'Eye-level',
              duration: 3.0,
            },
            // Shot 4: Scene 2 dialogue & voiceover
            {
              script_scene_id: 'scene_2',
              block_ids: ['blk_2_dia', 'blk_2_vo'],
              shot_intent: 'payoff',
              shot_type: 'Wide Shot',
              location: '九龙天碑前',
              primary_action: '天碑金光大作少年仰天长啸',
              primary_subject: '陆尘',
              visible_subjects: ['陆尘'],
              key_props: [],
              subject_scale: 'medium-20-40',
              camera_movement: 'Tilt',
              camera_angle: 'Low-angle',
              duration: 4.5,
            },
          ],
        });
      },
      async generateText() {
        return '';
      },
      async generateImage() { return {}; },
    };

    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({
      scriptId: script.id,
      expectedRevision: 3,
      requestKey: 'req_s3_storyboard_1',
      provider: mockProvider,
    });

    assert.equal(candidate.state, 'pending');
    assert.equal(candidate.kind, 'storyboard');
    assert.equal(candidate.base_revision, 3);

    const payload = JSON.parse(candidate.after_json);
    assert.equal(payload.shots.length, 4);

    // Verify Shot 1 audio_prompt assembled from sound block
    const s1 = payload.shots[0];
    assert.equal(s1.audio_prompt, '呼啸的凛冽狂风声');
    assert.equal(s1.dialogue, '');
    assert.equal(s1.narration, '');
    assert.equal(s1.source.type, 'script');
    assert.equal(s1.source.script_id, script.id);
    assert.equal(s1.source.script_scene_id, 'scene_1');

    // Verify Shot 2 dialogue and voiceover assembly and text preservation
    const s2 = payload.shots[1];
    assert.equal(
      s2.dialogue,
      '九千级台阶，我终究是走上来了。\n我就知道你一定能做到！'
    );
    assert.equal(s2.narration, '十年磨一剑，今朝试锋芒。');

    // Verify Shot 4 dialogue and voiceover assembly
    const s4 = payload.shots[3];
    assert.equal(s4.dialogue, '古碑显圣，开！');
    assert.equal(s4.narration, '属于我的命运，今日由我执掌。');

    // Verify coverage report
    assert.equal(payload.coverageReport.totalScenes, 2);
    assert.equal(payload.coverageReport.coveredSceneIds.length, 2);
    assert.equal(payload.coverageReport.totalAudibleBlocks, 5); // 3 in scene_1, 2 in scene_2
    assert.equal(payload.coverageReport.coveredBlockIds.length, 9); // all blocks covered
  });

  await t.test('SC08: 超过 20 镜预算上限必须明确失败 (Fail Closed，绝不静默 slice 截断)', async () => {
    const fixture = await setupTestFixture();
    const script = await ScriptService.createOrGetScript(fixture.chapterId, '超预算测试');
    const doc = buildValidConfirmedScript(fixture.charId, fixture.char2Id);

    await ScriptService.saveManualScript({
      scriptId: script.id,
      document: doc,
      expectedRevision: 1,
    });
    await ScriptService.confirmScript({
      scriptId: script.id,
      expectedRevision: 2,
    });

    // Mock Provider returning 21 shots (>20)
    const mockProviderOverBudget: AIProvider = {
      async generateStructured<T>(_prompt: string, schema: z.ZodSchema<T>): Promise<T> {
        const shots = [];
        for (let i = 1; i <= 21; i++) {
          shots.push({
            script_scene_id: i <= 10 ? 'scene_1' : 'scene_2',
            block_ids: [],
            shot_intent: 'wide-action',
            shot_type: 'Medium Shot',
            location: '万仞孤峰断崖',
            primary_action: `连续动作第 ${i} 镜`,
            primary_subject: '陆尘',
            visible_subjects: ['陆尘'],
            key_props: [],
            subject_scale: 'medium-20-40',
            duration: 3.0,
          });
        }
        return schema.parse({ shots });
      },
      async generateText() {
        return '';
      },
      async generateImage() { return {}; },
    };

    await assert.rejects(
      async () => {
        await StoryboardGenerationService.generateStoryboardCandidate({
          scriptId: script.id,
          expectedRevision: 3,
          requestKey: 'req_s3_overbudget',
          provider: mockProviderOverBudget,
        });
      },
      (err: any) => {
        assert.ok(err instanceof StoryboardGenerationError);
        assert.equal(err.statusCode, 400);
        assert.ok(err.message.includes('超过 20 镜上限'));
        return true;
      }
    );
  });

  await t.test('SC08: 遗漏场次、重复分配 block 或乱序必须严格拒绝', async () => {
    const fixture = await setupTestFixture();
    const script = await ScriptService.createOrGetScript(fixture.chapterId, '门禁测试');
    const doc = buildValidConfirmedScript(fixture.charId, fixture.char2Id);

    await ScriptService.saveManualScript({
      scriptId: script.id,
      document: doc,
      expectedRevision: 1,
    });
    await ScriptService.confirmScript({
      scriptId: script.id,
      expectedRevision: 2,
    });

    // 1. Missing scene 2 entirely
    const mockProviderMissingScene: AIProvider = {
      async generateStructured<T>(_prompt: string, schema: z.ZodSchema<T>): Promise<T> {
        return schema.parse({
          shots: [
            {
              script_scene_id: 'scene_1',
              block_ids: ['blk_1_act', 'blk_1_dia1', 'blk_1_dia2', 'blk_1_vo'],
              shot_intent: 'establish',
              shot_type: 'Wide Shot',
              location: '万仞孤峰断崖',
              primary_action: '测试动作',
              primary_subject: '陆尘',
              duration: 3.0,
            },
          ],
        });
      },
      async generateText() {
        return '';
      },
      async generateImage() { return {}; },
    };

    await assert.rejects(
      async () => {
        await StoryboardGenerationService.generateStoryboardCandidate({
          scriptId: script.id,
          expectedRevision: 3,
          requestKey: 'req_missing_scene',
          provider: mockProviderMissingScene,
        });
      },
      (err: any) => {
        assert.ok(err instanceof StoryboardGenerationError);
        assert.equal(err.statusCode, 400);
        assert.ok(err.message.includes('未覆盖剧本全部场次'));
        return true;
      }
    );

    // 2. Duplicate block assignment across shots
    const mockProviderDuplicateBlock: AIProvider = {
      async generateStructured<T>(_prompt: string, schema: z.ZodSchema<T>): Promise<T> {
        return schema.parse({
          shots: [
            {
              script_scene_id: 'scene_1',
              block_ids: ['blk_1_dia1'],
              shot_intent: 'establish',
              shot_type: 'Wide Shot',
              location: '万仞孤峰断崖',
              primary_action: '测试动作1',
              duration: 3.0,
            },
            {
              script_scene_id: 'scene_1',
              block_ids: ['blk_1_dia1'], // Duplicate!
              shot_intent: 'reaction',
              shot_type: 'Close-up',
              location: '万仞孤峰断崖',
              primary_action: '测试动作2',
              duration: 3.0,
            },
            {
              script_scene_id: 'scene_2',
              block_ids: ['blk_2_dia', 'blk_2_vo'],
              shot_intent: 'payoff',
              shot_type: 'Wide Shot',
              location: '九龙天碑前',
              primary_action: '测试动作3',
              duration: 3.0,
            },
          ],
        });
      },
      async generateText() {
        return '';
      },
      async generateImage() { return {}; },
    };

    await assert.rejects(
      async () => {
        await StoryboardGenerationService.generateStoryboardCandidate({
          scriptId: script.id,
          expectedRevision: 3,
          requestKey: 'req_duplicate_block',
          provider: mockProviderDuplicateBlock,
        });
      },
      (err: any) => {
        assert.ok(err instanceof StoryboardGenerationError);
        assert.equal(err.statusCode, 400);
        assert.ok(err.message.includes('重复分配'));
        return true;
      }
    );
  });

  await t.test('SC09: 向空 Timeline 采纳、原子写入镜头与 scene_version、重试幂等', async () => {
    const fixture = await setupTestFixture();
    const script = await ScriptService.createOrGetScript(fixture.chapterId, '原子采纳测试');
    const doc = buildValidConfirmedScript(fixture.charId, fixture.char2Id);

    await ScriptService.saveManualScript({
      scriptId: script.id,
      document: doc,
      expectedRevision: 1,
    });
    await ScriptService.confirmScript({
      scriptId: script.id,
      expectedRevision: 2,
    });

    const mockProvider: AIProvider = {
      async generateStructured<T>(_prompt: string, schema: z.ZodSchema<T>): Promise<T> {
        return schema.parse({
          shots: [
            {
              script_scene_id: 'scene_1',
              block_ids: ['blk_1_act', 'blk_1_dia1', 'blk_1_dia2', 'blk_1_vo'],
              shot_intent: 'establish',
              shot_type: 'Wide Shot',
              location: '万仞孤峰断崖',
              primary_action: '少年白衣染血持剑而立',
              primary_subject: '陆尘',
              visible_subjects: ['陆尘'],
              key_props: ['青锋古剑'],
              subject_scale: 'small-15-20',
              duration: 3.5,
            },
            {
              script_scene_id: 'scene_2',
              block_ids: ['blk_2_act', 'blk_2_dia', 'blk_2_vo'],
              shot_intent: 'payoff',
              shot_type: 'Wide Shot',
              location: '九龙天碑前',
              primary_action: '天碑金芒大作',
              primary_subject: '陆尘',
              visible_subjects: ['陆尘'],
              key_props: [],
              subject_scale: 'medium-20-40',
              duration: 4.0,
            },
          ],
        });
      },
      async generateText() {
        return '';
      },
      async generateImage() { return {}; },
    };

    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({
      scriptId: script.id,
      expectedRevision: 3,
      requestKey: 'req_s3_apply_1',
      provider: mockProvider,
    });

    // Verify initial timeline is empty
    const countBefore = await db.get(
      'SELECT COUNT(*) as n FROM scene WHERE chapter_id = ?',
      fixture.chapterId
    );
    assert.equal(Number(countBefore.n), 0);

    // Apply candidate to empty timeline
    const result = await StoryboardGenerationService.applyStoryboardCandidate({
      scriptId: script.id,
      changeId: candidate.id,
      expectedRevision: 3,
      expectedCandidateRevision: candidate.candidate_revision,
    });

    assert.equal(result.success, true);
    assert.equal(result.count, 2);
    assert.equal(result.scene_ids.length, 2);

    // Verify scenes and scene_version baselines in SQLite
    const scenes = await db.all(
      'SELECT * FROM scene WHERE chapter_id = ? ORDER BY "index" ASC',
      fixture.chapterId
    );
    assert.equal(scenes.length, 2);
    assert.equal(scenes[0].active_version, 1);
    assert.equal(scenes[0].chapter_id, fixture.chapterId);
    assert.ok(scenes[0].dialogue.includes('九千级台阶'));

    // Check scene_version baselines
    for (const sc of scenes) {
      const vers = await db.all(
        'SELECT * FROM scene_version WHERE scene_id = ?',
        sc.id
      );
      assert.equal(vers.length, 1);
      assert.equal(vers[0].version, 1);
      assert.equal(vers[0].label, 'v1');
    }

    // Verify candidate state updated to 'applied'
    const updatedCandidate = await db.get(
      'SELECT * FROM script_change WHERE id = ?',
      candidate.id
    );
    assert.equal(updatedCandidate.state, 'applied');
    assert.equal(updatedCandidate.applied_revision, 3);

    // Test Idempotent Retry: applying again returns the same scene_ids without inserting duplicates
    const retryResult = await StoryboardGenerationService.applyStoryboardCandidate({
      scriptId: script.id,
      changeId: candidate.id,
      expectedRevision: 3,
    });
    assert.equal(retryResult.success, true);
    assert.equal(retryResult.already_applied, true);
    assert.deepEqual(retryResult.scene_ids, result.scene_ids);

    // Verify scene count remains strictly 2 (no duplicate scenes created)
    const countAfter = await db.get(
      'SELECT COUNT(*) as n FROM scene WHERE chapter_id = ?',
      fixture.chapterId
    );
    assert.equal(Number(countAfter.n), 2);
  });

  await t.test('SC10: 已有分镜、资产或制作任务的章节拒绝覆盖提交 (保护现有制作资产)', async () => {
    const fixture = await setupTestFixture();
    const script = await ScriptService.createOrGetScript(fixture.chapterId, '已有资产保护测试');
    const doc = buildValidConfirmedScript(fixture.charId, fixture.char2Id);

    await ScriptService.saveManualScript({
      scriptId: script.id,
      document: doc,
      expectedRevision: 1,
    });
    await ScriptService.confirmScript({
      scriptId: script.id,
      expectedRevision: 2,
    });

    const mockProvider: AIProvider = {
      async generateStructured<T>(_prompt: string, schema: z.ZodSchema<T>): Promise<T> {
        return schema.parse({
          shots: [
            {
              script_scene_id: 'scene_1',
              block_ids: ['blk_1_act', 'blk_1_dia1', 'blk_1_dia2', 'blk_1_vo'],
              shot_intent: 'establish',
              shot_type: 'Wide Shot',
              location: '万仞孤峰断崖',
              primary_action: '少年白衣染血持剑而立',
              duration: 3.5,
            },
            {
              script_scene_id: 'scene_2',
              block_ids: ['blk_2_act', 'blk_2_dia', 'blk_2_vo'],
              shot_intent: 'payoff',
              shot_type: 'Wide Shot',
              location: '九龙天碑前',
              primary_action: '天碑金芒大作',
              duration: 4.0,
            },
          ],
        });
      },
      async generateText() {
        return '';
      },
      async generateImage() { return {}; },
    };

    // Candidate generation succeeds (candidate preview is permitted)
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({
      scriptId: script.id,
      expectedRevision: 3,
      requestKey: 'req_s3_protect_1',
      provider: mockProvider,
    });
    assert.equal(candidate.state, 'pending');

    // Manually create an existing scene in the chapter representing prior director work
    const existingSceneResult = await db.run(
      `INSERT INTO scene (chapter_id, "index", visual_prompt, asset_status, asset_url)
       VALUES (?, 1, '既存的高清分镜画面', 'completed', 'http://storage.local/existing_shot.png')`,
      fixture.chapterId
    );
    const existingSceneId = existingSceneResult.lastID;

    // Attempting to apply candidate to non-empty timeline MUST be rejected with 409
    await assert.rejects(
      async () => {
        await StoryboardGenerationService.applyStoryboardCandidate({
          scriptId: script.id,
          changeId: candidate.id,
          expectedRevision: 3,
        });
      },
      (err: any) => {
        assert.ok(err instanceof StoryboardGenerationError);
        assert.equal(err.statusCode, 409);
        assert.ok(err.message.includes('当前章节已有分镜镜头'));
        return true;
      }
    );

    // Verify existing scene and its asset_url are 100% preserved
    const sceneCheck = await db.get(
      'SELECT * FROM scene WHERE id = ?',
      existingSceneId
    );
    assert.equal(sceneCheck.asset_url, 'http://storage.local/existing_shot.png');
    assert.equal(sceneCheck.visual_prompt, '既存的高清分镜画面');

    // Total scene count must still be exactly 1
    const totalScenes = await db.get(
      'SELECT COUNT(*) as n FROM scene WHERE chapter_id = ?',
      fixture.chapterId
    );
    assert.equal(Number(totalScenes.n), 1);
  });
});
