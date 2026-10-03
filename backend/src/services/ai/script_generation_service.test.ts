import '../../test_setup';
import assert from 'node:assert/strict';
import test from 'node:test';
import { db, initDb } from '../../db/database';
import { ScriptService } from '../script_service';
import {
  ScriptGenerationService,
  ScriptGenerationError,
  GeneratedOutlineResponseSchema,
  GeneratedSceneResponseSchema,
  matchProjectCharacter,
} from './script_generation_service';
import { AgentExecutor } from './agent_executor';
import type { AIProvider } from './base';
import type { ScriptDocument, ScriptOutline } from '../../schemas/script';

test('Track 5 S2: ScriptGenerationService & Limited Agent Integration', async (t) => {
  await initDb();

  // Helper fixture builder
  const createFixture = async (customContent = '第一章小说正文：林轩踏入青云门大殿，面对掌门与众长老的审视。') => {
    const projId = Number(`${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-8));
    await db.run(
      `INSERT INTO project (id, title, description, settings, user_id)
       VALUES (?, ?, ?, ?, ?)`,
      projId,
      `S2测试项目_${projId}`,
      '测试短剧改编与生成',
      JSON.stringify({
        bible: { genre: '都市悬疑', style: '短剧快节奏', main_plot: '真假继承人' },
      }),
      'test_user'
    );

    const chapterId = `ch_s2_${projId}`;
    await db.run(
      `INSERT INTO chapter (id, project_id, "index", title, content, summary, condensed_content, status)
       VALUES (?, ?, 1, '第1章 风暴前夕', ?, '核心矛盾展开', '初入大典', 'draft')`,
      chapterId,
      projId,
      customContent
    );

    // Characters in project
    const char1Res = await db.run(
      `INSERT INTO character (project_id, name, role) VALUES (?, '林轩', '主角')`,
      projId
    );
    const char2Res = await db.run(
      `INSERT INTO character (project_id, name, role) VALUES (?, '苏沐雪', '女主')`,
      projId
    );

    const char1Id = Number((char1Res as any).lastID);
    const char2Id = Number((char2Res as any).lastID);

    return {
      projId,
      chapterId,
      char1: { id: char1Id, name: '林轩' },
      char2: { id: char2Id, name: '苏沐雪' },
      originalContent: customContent,
    };
  };

  // Helper mock AI provider
  const createMockProvider = (handlers: {
    onOutline?: (prompt: string) => any;
    onScene?: (prompt: string, callCount: number) => any;
    onSceneRewrite?: (prompt: string) => any;
  }): AIProvider => {
    let sceneCount = 0;
    return {
      name: 'mock-provider',
      async generate() {
        return 'mock text';
      },
      async generateStructured(prompt: string, schema: any) {
        if (schema === GeneratedOutlineResponseSchema && handlers.onOutline) {
          return handlers.onOutline(prompt);
        }
        if (schema === GeneratedSceneResponseSchema) {
          if (handlers.onSceneRewrite && prompt.includes('改写')) {
            return handlers.onSceneRewrite(prompt);
          }
          if (handlers.onScene) {
            sceneCount++;
            return handlers.onScene(prompt, sceneCount);
          }
        }
        throw new Error('Unhandled structured prompt in mock provider');
      },
    } as unknown as AIProvider;
  };

  await t.test('matchProjectCharacter matches exact and substring safely', () => {
    const chars = [
      { id: 1, name: '林轩' },
      { id: 2, name: '苏沐雪' },
      { id: 3, name: '王总监' },
    ];
    assert.equal(matchProjectCharacter('林轩', chars)?.id, 1);
    assert.equal(matchProjectCharacter('苏沐雪 (女总裁)', chars)?.id, 2);
    assert.equal(matchProjectCharacter('王总', chars)?.id, 3);
    assert.equal(matchProjectCharacter('张三', chars), null);
    assert.equal(matchProjectCharacter(null, chars), null);
  });

  await t.test('SC03: Outline -> full script candidate -> apply idempotency without LLM re-run', async () => {
    const fix = await createFixture();
    const script = await ScriptService.createOrGetScript(fix.chapterId);
    assert.equal(script.revision, 1);

    let outlineCallCount = 0;
    const mockOutline = {
      logline: '林轩在大典上遭陷害，当众展露逆天功法反击。',
      mustKeepEvents: [
        { id: 'ev_1', text: '林轩进入青云大殿', sourceParagraphIds: [] },
        { id: 'ev_2', text: '长老当众发难质疑资质', sourceParagraphIds: [] },
        { id: 'ev_3', text: '林轩一拳碎灵石打脸众人', sourceParagraphIds: [] },
      ],
      beats: [
        { id: 'b_1', purpose: '入殿被围观压迫', eventIds: ['ev_1'] },
        { id: 'b_2', purpose: '长老当面侮辱与挑衅', eventIds: ['ev_2'] },
        { id: 'b_3', purpose: '逆风翻盘碎石立威', eventIds: ['ev_3'] },
      ],
      endingHook: '突然神秘黑衣人潜入大殿，直扑林轩后心！',
    };

    const provider = createMockProvider({
      onOutline: () => {
        outlineCallCount++;
        return mockOutline;
      },
    });

    // 1. Generate outline candidate
    const outlineCand = await ScriptGenerationService.generateOutlineCandidate({
      scriptId: script.id,
      expectedRevision: 1,
      requestKey: 'req_sc03_outline',
      provider,
    });

    assert.equal(outlineCand.state, 'pending');
    assert.equal(outlineCand.kind, 'outline');
    assert.equal(outlineCallCount, 1);

    // Verify formal script still revision 1 and novel chapter untouched
    const unappliedScript = await ScriptService.getScriptById(script.id);
    assert.equal(unappliedScript.revision, 1);
    const chRow = (await db.get('SELECT content FROM chapter WHERE id = ?', fix.chapterId)) as any;
    assert.equal(chRow.content, fix.originalContent);

    // 2. Duplicate outline generation returns existing candidate without re-invoking LLM
    const duplicateCand = await ScriptGenerationService.generateOutlineCandidate({
      scriptId: script.id,
      expectedRevision: 1,
      requestKey: 'req_sc03_outline',
      provider,
    });
    assert.equal(duplicateCand.id, outlineCand.id);
    assert.equal(outlineCallCount, 1); // No re-run!

    // 3. Apply outline candidate
    const appliedOutlineScript = await ScriptService.applyCandidate({
      scriptId: script.id,
      changeId: outlineCand.id,
      expectedRevision: 1,
      expectedCandidateRevision: outlineCand.candidate_revision,
    });
    assert.equal(appliedOutlineScript.revision, 2);
    assert.equal(appliedOutlineScript.document.outline?.logline, mockOutline.logline);

    // 3.1 Idempotency check: retrying with original requestKey after apply returns candidate even if revision bumped
    const postApplyCand = await ScriptGenerationService.generateOutlineCandidate({
      scriptId: script.id,
      expectedRevision: 1,
      requestKey: 'req_sc03_outline',
      provider,
    });
    assert.equal(postApplyCand.id, outlineCand.id);
    assert.equal(outlineCallCount, 1);

    // 4. Generate full script candidate based on outline
    let sceneCalls = 0;
    const fullScriptProvider = createMockProvider({
      onScene: (_p, idx) => {
        sceneCalls++;
        return {
          location: { name: `青云大殿第${idx}重`, description: '宏伟仙门大殿' },
          interiorExterior: 'interior' as const,
          timeOfDay: 'day',
          characterNames: ['林轩', '苏沐雪'],
          coveredEventIds: [`ev_${idx}`],
          blocks: [
            {
              type: 'action' as const,
              text: [
                '林轩进入青云大殿',
                '长老当众发难质疑资质',
                '林轩一拳碎灵石打脸众人',
              ][idx - 1] || '众人肃立，剑拔弩张',
            },
            {
              type: 'dialogue' as const,
              characterName: '林轩',
              delivery: '冷冷地',
              text: `林轩台词：我林轩何须向尔等证明！（第${idx}场）`,
            },
            {
              type: 'dialogue' as const,
              characterName: '苏沐雪',
              delivery: '焦急',
              text: `苏沐雪台词：小心！（第${idx}场）`,
            },
            { type: 'sound' as const, text: '音效：灵气激荡之声' },
          ],
          estimatedDurationSec: 40,
        };
      },
    });

    const scriptCand = await ScriptGenerationService.generateFullScriptCandidate({
      scriptId: script.id,
      expectedRevision: 2,
      requestKey: 'req_sc03_full_script',
      provider: fullScriptProvider,
    });

    assert.equal(scriptCand.state, 'pending');
    assert.equal(scriptCand.kind, 'script');
    assert.equal(sceneCalls, 3); // 3 scenes matching 3 beats

    // 5. Apply full script candidate
    const appliedScript = await ScriptService.applyCandidate({
      scriptId: script.id,
      changeId: scriptCand.id,
      expectedRevision: 2,
      expectedCandidateRevision: scriptCand.candidate_revision,
    });

    assert.equal(appliedScript.revision, 3);
    assert.equal(appliedScript.document.scenes.length, 3);
    assert.equal(appliedScript.document.scenes[0]?.blocks.length, 4);

    // Check dialogue characterId mapped to project character
    const sc1Dialogue = appliedScript.document.scenes[0]?.blocks.find((b) => b.type === 'dialogue');
    assert.equal((sc1Dialogue as any)?.characterId, fix.char1.id);

    // 6. Applying already applied candidate is idempotent and does not increment revision
    const reapply = await ScriptService.applyCandidate({
      scriptId: script.id,
      changeId: scriptCand.id,
      expectedRevision: 3,
    });
    assert.equal(reapply.revision, 3);

    // Verify novel chapter remains 100% immutable throughout
    const finalCh = (await db.get('SELECT content FROM chapter WHERE id = ?', fix.chapterId)) as any;
    assert.equal(finalCh.content, fix.originalContent);
  });

  await t.test('SC06: Empty output, invalid JSON, unknown characters, and scene failure aborts cleanly', async () => {
    const fix = await createFixture();
    const script = await ScriptService.createOrGetScript(fix.chapterId);

    // 1. LLM returns empty / null
    const emptyProvider = createMockProvider({
      onOutline: () => null,
    });
    await assert.rejects(
      () =>
        ScriptGenerationService.generateOutlineCandidate({
          scriptId: script.id,
          expectedRevision: 1,
          requestKey: 'req_fail_empty',
          provider: emptyProvider,
        }),
      (err: any) => err instanceof ScriptGenerationError && err.statusCode === 502
    );

    // 2. Unknown character in dialogue
    const unknownCharProvider = createMockProvider({
      onOutline: () => ({
        logline: '梗概',
        mustKeepEvents: [{ id: 'e1', text: '事' }],
        beats: [{ id: 'b1', purpose: '节拍', eventIds: ['e1'] }],
        endingHook: '钩子',
      }),
      onScene: () => ({
        location: { name: '正厅' },
        blocks: [
          { type: 'action', text: '走入' },
          { type: 'dialogue', characterName: '未登记的虚构路人甲', text: '此乃何人？' },
        ],
      }),
    });

    await assert.rejects(
      () =>
        ScriptGenerationService.generateFullScriptCandidate({
          scriptId: script.id,
          expectedRevision: 1,
          requestKey: 'req_fail_unknown_char',
          provider: unknownCharProvider,
        }),
      (err: any) => {
        assert.ok(err instanceof ScriptGenerationError);
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /未知角色/);
        return true;
      }
    );

    // 3. Failure in middle scene aborts the entire generation and creates NO candidate
    const midFailProvider = createMockProvider({
      onOutline: () => ({
        logline: '梗概',
        mustKeepEvents: [{ id: 'e1', text: '事' }, { id: 'e2', text: '事2' }, { id: 'e3', text: '事3' }],
        beats: [
          { id: 'b1', purpose: '节拍1', eventIds: ['e1'] },
          { id: 'b2', purpose: '节拍2', eventIds: ['e2'] },
          { id: 'b3', purpose: '节拍3', eventIds: ['e3'] },
        ],
        endingHook: '钩子',
      }),
      onScene: (_p, count) => {
        if (count === 2) {
          throw new Error('LLM connection timeout on scene 2');
        }
        return {
          location: { name: '正厅' },
          blocks: [{ type: 'action', text: '动作' }],
        };
      },
    });

    await assert.rejects(
      () =>
        ScriptGenerationService.generateFullScriptCandidate({
          scriptId: script.id,
          expectedRevision: 1,
          requestKey: 'req_fail_mid_scene',
          provider: midFailProvider,
        }),
      (err: any) => {
        assert.ok(err instanceof ScriptGenerationError);
        assert.match(err.message, /第 2 场生成失败/);
        return true;
      }
    );

    // Check no candidate created for this request key
    const midChange = await db.get(
      'SELECT * FROM script_change WHERE script_id = ? AND request_key = ?',
      script.id,
      'req_fail_mid_scene'
    );
    assert.equal(midChange, undefined);

    // Formal script document still at revision 1 and untouched
    const currentScript = await ScriptService.getScriptById(script.id);
    assert.equal(currentScript.revision, 1);
    assert.equal(currentScript.document.scenes.length, 0);
    const leftover = await db.all(
      'SELECT id FROM script_change WHERE script_id = ?',
      script.id
    );
    assert.equal(leftover.length, 0);

    // 4. Over-budget novel chapter (>30,000 words) rejected
    const hugeProse = '超长小说正文。'.repeat(5000); // 35,000 chars > 30,000
    const hugeFix = await createFixture(hugeProse);
    const hugeScript = await ScriptService.createOrGetScript(hugeFix.chapterId);

    await assert.rejects(
      () =>
        ScriptGenerationService.generateOutlineCandidate({
          scriptId: hugeScript.id,
          expectedRevision: 1,
          requestKey: 'req_huge',
          provider: emptyProvider,
        }),
      (err: any) => {
        assert.ok(err instanceof ScriptGenerationError);
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /超过单章 30,000 字上限/);
        return true;
      }
    );
  });

  await t.test('SC07: Scene rewrite strictly preserves stable IDs and leaves other scenes untouched', async () => {
    const fix = await createFixture();
    const script = await ScriptService.createOrGetScript(fix.chapterId);

    // Set up a 3-scene base script
    const initialDoc: ScriptDocument = {
      schemaVersion: 1,
      title: '三场基础剧本',
      targetDurationSec: 120,
      outline: {
        logline: '基础提纲',
        mustKeepEvents: [],
        beats: [],
        endingHook: '',
      },
      locations: [{ id: 'loc_hall', name: '青云大殿', description: '' }],
      props: [],
      scenes: [
        {
          id: 'sc_alpha',
          beatIds: ['b1'],
          eventIds: [],
          sourceParagraphIds: [],
          locationId: 'loc_hall',
          interiorExterior: 'interior',
          timeOfDay: 'day',
          characterIds: [fix.char1.id],
          propIds: [],
          blocks: [{ id: 'b_1_1', type: 'action', text: '第一场初始动作，林轩步入' }],
          estimatedDurationSec: 30,
        },
        {
          id: 'sc_beta',
          beatIds: ['b2'],
          eventIds: [],
          sourceParagraphIds: [],
          locationId: 'loc_hall',
          interiorExterior: 'interior',
          timeOfDay: 'day',
          characterIds: [fix.char1.id],
          propIds: [],
          blocks: [{ id: 'b_2_1', type: 'action', text: '第二场初始动作，众人嘲弄' }],
          estimatedDurationSec: 30,
        },
        {
          id: 'sc_gamma',
          beatIds: ['b3'],
          eventIds: [],
          sourceParagraphIds: [],
          locationId: 'loc_hall',
          interiorExterior: 'interior',
          timeOfDay: 'day',
          characterIds: [fix.char2.id],
          propIds: [],
          blocks: [{ id: 'b_3_1', type: 'action', text: '第三场初始动作，苏沐雪惊呼' }],
          estimatedDurationSec: 30,
        },
      ],
    };

    const saved = await ScriptService.saveManualScript({
      scriptId: script.id,
      document: initialDoc,
      expectedRevision: 1,
    });
    assert.equal(saved.revision, 2);

    // Target rewrite: sc_beta (Scene 2)
    const rewriteProvider = createMockProvider({
      onSceneRewrite: () => ({
        location: { name: '青云大殿' },
        interiorExterior: 'interior' as const,
        timeOfDay: 'night',
        blocks: [
          { type: 'action' as const, text: '重写后的第二场高能动作：林轩气势暴涨，震碎周围案几！' },
          {
            type: 'dialogue' as const,
            characterName: '林轩',
            delivery: '霸气凌厉',
            text: '尔等宵小，也配评判我林轩？',
          },
        ],
        estimatedDurationSec: 45,
      }),
    });

    const rewriteCand = await ScriptGenerationService.generateSceneRewriteCandidate({
      scriptId: script.id,
      targetSceneId: 'sc_beta',
      expectedRevision: 2,
      requestKey: 'req_rewrite_beta',
      provider: rewriteProvider,
    });

    assert.equal(rewriteCand.kind, 'scene');
    assert.equal(rewriteCand.state, 'pending');

    const parsedScene = JSON.parse(rewriteCand.after_json);
    assert.equal(parsedScene.id, 'sc_beta'); // Stable ID preserved!

    // Apply rewrite candidate
    const updatedScript = await ScriptService.applyCandidate({
      scriptId: script.id,
      changeId: rewriteCand.id,
      expectedRevision: 2,
      expectedCandidateRevision: rewriteCand.candidate_revision,
    });

    assert.equal(updatedScript.revision, 3);
    assert.equal(updatedScript.document.scenes.length, 3);

    // Check Scene 1 (sc_alpha) - EXACTLY unchanged
    assert.equal(updatedScript.document.scenes[0]?.id, 'sc_alpha');
    assert.equal(updatedScript.document.scenes[0]?.blocks[0]?.text, '第一场初始动作，林轩步入');

    // Check Scene 2 (sc_beta) - UPDATED with stable ID
    assert.equal(updatedScript.document.scenes[1]?.id, 'sc_beta');
    assert.equal(
      updatedScript.document.scenes[1]?.blocks[0]?.text,
      '重写后的第二场高能动作：林轩气势暴涨，震碎周围案几！'
    );
    assert.equal(updatedScript.document.scenes[1]?.timeOfDay, 'night');

    // Check Scene 3 (sc_gamma) - EXACTLY unchanged
    assert.equal(updatedScript.document.scenes[2]?.id, 'sc_gamma');
    assert.equal(updatedScript.document.scenes[2]?.blocks[0]?.text, '第三场初始动作，苏沐雪惊呼');
  });

  await t.test('SC05: Source freshness check rejects applying candidates after novel text changes', async () => {
    const fix = await createFixture();
    const script = await ScriptService.createOrGetScript(fix.chapterId);

    const provider = createMockProvider({
      onOutline: () => ({
        logline: '梗概',
        mustKeepEvents: [{ id: 'e1', text: '事' }],
        beats: [{ id: 'b1', purpose: '节拍', eventIds: ['e1'] }],
        endingHook: '钩子',
      }),
    });

    const cand = await ScriptGenerationService.generateOutlineCandidate({
      scriptId: script.id,
      expectedRevision: 1,
      requestKey: 'req_sc05_stale',
      provider,
    });

    // Now modify the novel chapter prose in the database
    await db.run(
      'UPDATE chapter SET content = ? WHERE id = ?',
      '小说正文被作者大改了，引入了全新的世界观背景。',
      fix.chapterId
    );

    // Attempt to apply the candidate created against the old source
    await assert.rejects(
      () =>
        ScriptService.applyCandidate({
          scriptId: script.id,
          changeId: cand.id,
          expectedRevision: 1,
          expectedCandidateRevision: cand.candidate_revision,
        }),
      (err: any) => {
        assert.ok(err.message.includes('Source novel content or project context has changed'));
        return true;
      }
    );
  });

  await t.test('SC12: AgentExecutor generates pending script candidates without touching novel prose', async () => {
    const fix = await createFixture();
    const script = await ScriptService.createOrGetScript(fix.chapterId);

    const provider = createMockProvider({
      onOutline: () => ({
        logline: 'Agent 生成提纲梗概',
        mustKeepEvents: [{ id: 'e1', text: '重要保留事件' }],
        beats: [{ id: 'b1', purpose: '节拍', eventIds: ['e1'] }],
        endingHook: '悬念钩子',
      }),
    });

    // 1. GENERATE_SCRIPT_OUTLINE via Agent OS
    const outlineResult = await AgentExecutor.executeOne(
      {
        op: 'GENERATE_SCRIPT_OUTLINE',
        chapterId: fix.chapterId,
        instructions: '提炼高张力戏剧冲突',
        surface: 'script',
      },
      {
        projectId: fix.projId,
        chapterId: fix.chapterId,
        apply: true,
        surface: 'script',
        provider,
      }
    );

    assert.equal(outlineResult.status, 'success');
    assert.ok((outlineResult.data as any)?.candidateId);

    // Verify candidate in DB is pending
    const candRow = await db.get(
      'SELECT * FROM script_change WHERE id = ?',
      (outlineResult.data as any).candidateId
    );
    assert.equal((candRow as any).state, 'pending');

    // Verify novel prose is completely untouched
    const chRow = (await db.get('SELECT content FROM chapter WHERE id = ?', fix.chapterId)) as any;
    assert.equal(chRow.content, fix.originalContent);

    // 2. Reject cross-project chapter reference
    await assert.rejects(
      () =>
        AgentExecutor.executeOne(
          {
            op: 'GENERATE_SCRIPT_OUTLINE',
            chapterId: fix.chapterId,
            surface: 'script',
          },
          {
            projectId: fix.projId + 99999, // Wrong project!
            chapterId: fix.chapterId,
            apply: true,
            surface: 'script',
            provider,
          }
        ),
      (err: any) => {
        assert.match(err.message, /Cross-project chapter reference rejected/);
        return true;
      }
    );
  });

  await t.test('Issue 3: Outline candidates do not refresh a changed source; refreshSourceSnapshot still does', async () => {
    const fix = await createFixture();
    const script = await ScriptService.createOrGetScript(fix.chapterId);

    // 1. Novel content changes
    const newContent = '这是作者修改后的全新正文：林轩获得了至尊剑骨，修为突飞猛进。';
    await db.run('UPDATE chapter SET content = ? WHERE id = ?', newContent, fix.chapterId);

    // Verify freshness shows sourceChanged
    const refreshedScript = await ScriptService.getScriptById(script.id);
    assert.equal(refreshedScript.freshness.sourceChanged, true);

    // 2. Refresh source snapshot directly in outline phase (0 scenes)
    const syncedScript = await ScriptService.refreshSourceSnapshot({
      scriptId: script.id,
      expectedRevision: script.revision,
    });
    assert.equal(syncedScript.freshness.sourceChanged, false);
    assert.equal(syncedScript.document.scenes.length, 0);
    const syncedRow = await db.get(
      'SELECT source_snapshot_json, source_content_hash FROM chapter_script WHERE id = ?',
      script.id
    );

    // 3. Change novel text again
    const newerContent = '这是再次修改后的正文：林轩在演武场一鸣惊人。';
    await db.run('UPDATE chapter SET content = ? WHERE id = ?', newerContent, fix.chapterId);

    // 4. Generate candidate against newer text
    const provider = createMockProvider({
      onOutline: () => ({
        logline: '林轩剑骨觉醒',
        mustKeepEvents: [{ id: 'e_new', text: '剑骨觉醒一鸣惊人', sourceParagraphIds: [] }],
        beats: [{ id: 'b_new', purpose: '觉醒爆发', eventIds: ['e_new'] }],
        endingHook: '长老惊叹',
      }),
    });

    const newCandidate = await ScriptGenerationService.generateOutlineCandidate({
      scriptId: syncedScript.id,
      expectedRevision: syncedScript.revision,
      requestKey: 'req_newer_candidate',
      provider,
    });

    // 5. An outline candidate must not adopt the newer chapter as the whole-script baseline
    await assert.rejects(
      () =>
        ScriptService.applyCandidate({
          scriptId: syncedScript.id,
          changeId: newCandidate.id,
          expectedRevision: syncedScript.revision,
          expectedCandidateRevision: newCandidate.candidate_revision,
        }),
      (err: any) => {
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /keep the existing source snapshot/);
        return true;
      }
    );

    const current = await ScriptService.getScriptById(script.id);
    assert.equal(current.freshness.sourceChanged, true);
    assert.equal(current.document.outline.logline, '');
    const row = await db.get(
      'SELECT source_snapshot_json, source_content_hash FROM chapter_script WHERE id = ?',
      script.id
    );
    assert.deepEqual(row, syncedRow);
  });

  await t.test('Issue 1: Novel text changes during LLM generation are captured at input time and candidate cannot be applied', async () => {
    const fix = await createFixture('初始小说正文内容，主角准备参加入门考核。');
    const script = await ScriptService.createOrGetScript(fix.chapterId);

    // Mock LLM provider that mutates the chapter content during generation (simulating in-flight novel edit)
    const provider = createMockProvider({
      onOutline: () => {
        // Mutate novel text in DB while model is "running"
        db.run(
          'UPDATE chapter SET content = ? WHERE id = ?',
          '模型生成期间被并发修改的小说新正文内容。',
          fix.chapterId
        );
        return {
          logline: '基于初始正文生成的梗概',
          mustKeepEvents: [{ id: 'ev_1', text: '准备参加入门考核', sourceParagraphIds: [] }],
          beats: [{ id: 'b_1', purpose: '考核开端', eventIds: ['ev_1'] }],
          endingHook: '悬念钩子',
        };
      },
    });

    const cand = await ScriptGenerationService.generateOutlineCandidate({
      scriptId: script.id,
      expectedRevision: 1,
      requestKey: 'req_inflight_mutation',
      provider,
    });

    // Verify candidate snapshot reflects the initial novel text hash at input time
    const candSnapshot = JSON.parse(cand.source_snapshot_json || '{}');
    assert.equal(candSnapshot.content, '初始小说正文内容，主角准备参加入门考核。');

    // Attempting to apply the candidate generated from old content must be rejected with 409
    await assert.rejects(
      () =>
        ScriptService.applyCandidate({
          scriptId: script.id,
          changeId: cand.id,
          expectedRevision: 1,
          expectedCandidateRevision: cand.candidate_revision,
        }),
      (err: any) => {
        assert.ok(err.message.includes('Source novel content or project context has changed'));
        return true;
      }
    );

    // Script freshness detects sourceChanged = true
    const current = await ScriptService.getScriptById(script.id);
    assert.equal(current.freshness.sourceChanged, true);
    assert.equal(current.freshness.contentChanged, true);
  });

  await t.test('Issue 4: Paragraph ID sanitization prevents p_999 hallucination and guarantees valid prompt paragraphs', async () => {
    const fix = await createFixture('第一段小说正文。\n第二段小说正文。');
    const script = await ScriptService.createOrGetScript(fix.chapterId);

    // Model returns hallucinated p_999
    const provider = createMockProvider({
      onOutline: (prompt) => {
        assert.ok(prompt.includes('[p_1] 第一段小说正文。'));
        assert.ok(prompt.includes('[p_2] 第二段小说正文。'));
        return {
        logline: '核心梗概',
        mustKeepEvents: [
          { id: 'ev_1', text: '第一段事件', sourceParagraphIds: ['p_999'] },
        ],
        beats: [{ id: 'b_1', purpose: '第一段节拍', eventIds: ['ev_1'] }],
        endingHook: '结尾钩子',
        };
      },
    });

    const outlineCand = await ScriptGenerationService.generateOutlineCandidate({
      scriptId: script.id,
      expectedRevision: 1,
      requestKey: 'req_sanitize_p999',
      provider,
    });

    const parsedOutline: ScriptOutline = JSON.parse(outlineCand.after_json);
    // p_999 must NOT be in the saved outline! It must be sanitized to valid paragraph ID (p_1)
    assert.ok(!parsedOutline.mustKeepEvents[0]?.sourceParagraphIds?.includes('p_999'));
    assert.ok(parsedOutline.mustKeepEvents[0]?.sourceParagraphIds?.includes('p_1'));
  });

  await t.test('Issue 4: Must-keep events coverage validation rejects unfulfilled events and accepts genuine coverage', async () => {
    const fix = await createFixture('第一段正文。\n第二段正文。');
    const script = await ScriptService.createOrGetScript(fix.chapterId);

    let receivedScenePrompt = '';
    // 1. Model omits coveredEventIds and outputs scene blocks unrelated to ev_2 -> must reject with 502
    const failingProvider = createMockProvider({
      onOutline: () => ({
        logline: '核心梗概',
        mustKeepEvents: [
          { id: 'ev_1', text: '林轩入殿', sourceParagraphIds: ['p_1'] },
          { id: 'ev_2', text: '长老质疑与碎石打脸', sourceParagraphIds: ['p_2'] },
        ],
        beats: [
          { id: 'b_1', purpose: '入殿', eventIds: ['ev_1'] },
          { id: 'b_2', purpose: '药屋夜间的对质，禁止移到大殿或日间', eventIds: ['ev_2'] },
        ],
        endingHook: '钩子',
      }),
      onScene: (prompt) => {
        receivedScenePrompt = prompt;
        return {
          location: { name: '青云大殿', description: '' },
          interiorExterior: 'interior',
          timeOfDay: 'day',
          characterNames: [fix.char1.name],
          coveredEventIds: ['ev_1', 'ev_2'],
          blocks: [{ id: 'b1', type: 'action', text: '林轩悠闲品茶' }],
        };
      },
    });

    await assert.rejects(
      () =>
        ScriptGenerationService.generateFullScriptCandidate({
          scriptId: script.id,
          expectedRevision: 1,
          requestKey: 'req_missing_ev2',
          provider: failingProvider,
        }),
      (err: any) => {
        assert.ok(err instanceof ScriptGenerationError);
        assert.equal(err.statusCode, 502);
        assert.match(err.message, /未能覆盖提纲中的必保关键事件/);
        assert.match(err.message, /长老质疑与碎石打脸/);
        return true;
      }
    );

    // Verify prompt included the source paragraph content
    assert.ok(receivedScenePrompt.includes('--- 对应小说原文段落 ---'));
    assert.ok(receivedScenePrompt.includes('[p_1] 第一段正文。') || receivedScenePrompt.includes('[p_2] 第二段正文。'));
    assert.ok(receivedScenePrompt.includes('药屋夜间的对质，禁止移到大殿或日间'));

    // 2. Model outputs genuine coverage for both ev_1 and ev_2 -> succeeds!
    const passingProvider = createMockProvider({
      onOutline: () => ({
        logline: '核心梗概',
        mustKeepEvents: [
          { id: 'ev_1', text: '林轩入殿', sourceParagraphIds: ['p_1'] },
          { id: 'ev_2', text: '长老质疑与碎石打脸', sourceParagraphIds: ['p_2'] },
        ],
        beats: [
          { id: 'b_1', purpose: '入殿', eventIds: ['ev_1'] },
          { id: 'b_2', purpose: '打脸', eventIds: ['ev_2'] },
        ],
        endingHook: '钩子',
      }),
      onScene: (_p, idx) => ({
        location: { name: '青云大殿', description: '' },
        interiorExterior: 'interior',
        timeOfDay: 'day',
        characterNames: [fix.char1.name],
        coveredEventIds: [idx === 1 ? 'ev_1' : 'ev_2'],
        blocks: [
          {
            id: `b_${idx}`,
            type: 'action',
            text: idx === 1 ? '林轩入殿，大步迈入青云大殿' : '长老质疑与碎石打脸，林轩运劲击碎测道石',
          },
        ],
      }),
    });

    const fullScriptCand = await ScriptGenerationService.generateFullScriptCandidate({
      scriptId: script.id,
      expectedRevision: 1,
      requestKey: 'req_genuine_coverage',
      provider: passingProvider,
    });

    const parsed: ScriptDocument = JSON.parse(fullScriptCand.after_json);
    assert.equal(parsed.scenes.length, 2); // One scene per adopted beat.
    assert.deepEqual(parsed.scenes[0]?.eventIds, ['ev_1']);
    assert.deepEqual(parsed.scenes[1]?.eventIds, ['ev_2']);
    assert.ok(!parsed.scenes.some((s) => s.sourceParagraphIds.includes('p_999')));
  });
});
