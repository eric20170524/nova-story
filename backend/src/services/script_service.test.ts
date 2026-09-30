import '../test_setup';
import assert from 'node:assert/strict';
import test from 'node:test';
import { db, initDb } from '../db/database';
import { ScriptService, ScriptServiceError } from './script_service';
import {
  createEmptyScriptDocument,
  validateScriptForConfirmation,
  type ScriptDocument,
} from '../schemas/script';

test('Track 5 S1-BE: ScriptService database migrations, models, and freshness', async (t) => {
  await initDb();

  // Helper to create test project and chapter
  const createTestFixture = async (customContent = '第一章小说正文，主角初入青云宗。') => {
    const projId = Number(`${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-8));
    await db.run(
      `INSERT INTO project (id, title, description, settings, user_id)
       VALUES (?, ?, ?, ?, ?)`,
      projId,
      `剧本测试项目_${projId}`,
      '仙侠修真短剧',
      JSON.stringify({
        bible: { genre: 'xianxia', style: 'realistic', main_plot: '逆天改命' },
      }),
      'test_user'
    );

    const chapterId = `ch_test_${projId}_${Math.floor(Math.random() * 1000)}`;
    const originalContent = customContent;
    const originalSummary = '主角入宗拜师';
    const originalCondensed = '初入宗门经历。';

    await db.run(
      `INSERT INTO chapter (id, project_id, "index", title, content, summary, condensed_content, status)
       VALUES (?, ?, 1, '第1章 初入宗门', ?, ?, ?, 'draft')`,
      chapterId,
      projId,
      originalContent,
      originalSummary,
      originalCondensed
    );

    const charRes = await db.run(
      `INSERT INTO character (project_id, name, role)
       VALUES (?, '林轩', '主角')`,
      projId
    );
    const charId = Number((charRes as any).lastID);

    return { projId, chapterId, charId, originalContent, originalSummary, originalCondensed };
  };

  await t.test('SC01: Novel prose immutability across full script lifecycle', async () => {
    const fixture = await createTestFixture();

    // 1. Create empty script
    const initialScript = await ScriptService.createOrGetScript(fixture.chapterId);
    assert.equal(initialScript.revision, 1);
    assert.equal(initialScript.status, 'draft');
    assert.equal(initialScript.chapterId, fixture.chapterId);

    // Verify novel chapter unchanged
    let chapterRow = (await db.get('SELECT * FROM chapter WHERE id = ?', fixture.chapterId)) as any;
    assert.equal(chapterRow.content, fixture.originalContent);
    assert.equal(chapterRow.summary, fixture.originalSummary);
    assert.equal(chapterRow.condensed_content, fixture.originalCondensed);

    // 2. Manual edit script with 2 scenes
    const docWithScenes: ScriptDocument = {
      ...initialScript.document,
      locations: [
        { id: 'loc_mountain', name: '青云山道', description: '陡峭青石台阶' },
        { id: 'loc_gate', name: '青云山门', description: '高耸入云的汉白玉山门' },
      ],
      scenes: [
        {
          id: 'scene_01',
          beatIds: [],
          eventIds: [],
          sourceParagraphIds: [],
          locationId: 'loc_mountain',
          interiorExterior: 'exterior',
          timeOfDay: 'day',
          characterIds: [fixture.charId],
          propIds: [],
          blocks: [
            { id: 'b_act_1', type: 'action', text: '林轩背负竹篓走在山道上。' },
            { id: 'b_dia_1', type: 'dialogue', characterId: fixture.charId, text: '这石阶好长。' },
          ],
        },
        {
          id: 'scene_02',
          beatIds: [],
          eventIds: [],
          sourceParagraphIds: [],
          locationId: 'loc_gate',
          interiorExterior: 'exterior',
          timeOfDay: 'day',
          characterIds: [fixture.charId],
          propIds: [],
          blocks: [
            { id: 'b_act_2', type: 'action', text: '抬头望见青云山门。' },
            { id: 'b_vo_1', type: 'voiceover', characterId: fixture.charId, text: '终于到了。' },
          ],
        },
      ],
    };

    const saved = await ScriptService.saveManualScript({
      scriptId: initialScript.id,
      document: docWithScenes,
      expectedRevision: 1,
    });
    assert.equal(saved.revision, 2);
    assert.equal(saved.status, 'draft');
    assert.equal(saved.document.scenes.length, 2);

    // Verify novel chapter unchanged
    chapterRow = (await db.get('SELECT * FROM chapter WHERE id = ?', fixture.chapterId)) as any;
    assert.equal(chapterRow.content, fixture.originalContent);
    assert.equal(chapterRow.summary, fixture.originalSummary);
    assert.equal(chapterRow.condensed_content, fixture.originalCondensed);

    // 3. Confirm script
    const confirmed = await ScriptService.confirmScript({
      scriptId: saved.id,
      expectedRevision: 2,
    });
    assert.equal(confirmed.revision, 3);
    assert.equal(confirmed.status, 'confirmed');

    // Verify novel chapter unchanged
    chapterRow = (await db.get('SELECT * FROM chapter WHERE id = ?', fixture.chapterId)) as any;
    assert.equal(chapterRow.content, fixture.originalContent);
    assert.equal(chapterRow.summary, fixture.originalSummary);
    assert.equal(chapterRow.condensed_content, fixture.originalCondensed);

    // 4. Restore previous version
    const restored = await ScriptService.restoreScript({
      scriptId: confirmed.id,
      expectedRevision: 3,
    });
    assert.equal(restored.revision, 4);
    assert.equal(restored.status, 'draft');

    // Verify novel chapter 100% byte-for-byte identical
    chapterRow = (await db.get('SELECT * FROM chapter WHERE id = ?', fixture.chapterId)) as any;
    assert.equal(chapterRow.content, fixture.originalContent);
    assert.equal(chapterRow.summary, fixture.originalSummary);
    assert.equal(chapterRow.condensed_content, fixture.originalCondensed);
  });

  await t.test('SC02: Manual authoring without AI models, character references, and markdown export', async () => {
    const fixture = await createTestFixture();

    // Insert characters
    const c1 = await db.run(
      `INSERT INTO character (project_id, name, role, visual_tags)
       VALUES (?, '林轩', '男主', '{}')`,
      fixture.projId
    );
    const char1Id = Number((c1 as any).lastID);

    const c2 = await db.run(
      `INSERT INTO character (project_id, name, role, visual_tags)
       VALUES (?, '陆雪琪', '师姐', '{}')`,
      fixture.projId
    );
    const char2Id = Number((c2 as any).lastID);

    const script = await ScriptService.createOrGetScript(fixture.chapterId);

    const doc: ScriptDocument = {
      schemaVersion: 1,
      title: '青云第一战',
      targetDurationSec: 150,
      outline: {
        logline: '林轩拜入青云门，初见冷艳师姐陆雪琪。',
        mustKeepEvents: [
          { id: 'ev_1', text: '林轩登山拜师', sourceParagraphIds: ['p1'] },
          { id: 'ev_2', text: '陆雪琪冷面指路', sourceParagraphIds: ['p2'] },
        ],
        beats: [
          { id: 'beat_1', purpose: '引出主角登山困顿', eventIds: ['ev_1'] },
          { id: 'beat_2', purpose: '仙子登场施援', eventIds: ['ev_2'] },
        ],
        endingHook: '山门钟声突然大作，预示魔宗袭山。',
      },
      locations: [
        { id: 'loc_steps', name: '问仙石阶', description: '陡峭蜿蜒的古朴青石台阶' },
      ],
      props: [
        { id: 'prop_basket', name: '采药竹篓', description: '破旧但结实的竹编背篓' },
      ],
      scenes: [
        {
          id: 'sc_01',
          beatIds: ['beat_1'],
          eventIds: ['ev_1'],
          sourceParagraphIds: ['p1'],
          locationId: 'loc_steps',
          interiorExterior: 'exterior',
          timeOfDay: '清晨',
          characterIds: [char1Id],
          propIds: ['prop_basket'],
          blocks: [
            { id: 'b_1', type: 'action', text: '晨雾弥漫，林轩气喘吁吁地蹬上一级石阶。' },
            { id: 'b_2', type: 'dialogue', characterId: char1Id, delivery: '抹去额头汗珠', text: '九千九百九十九级……还有多远？' },
            { id: 'b_3', type: 'sound', text: '微风拂过竹林的沙沙声。' },
          ],
          estimatedDurationSec: 45,
        },
        {
          id: 'sc_02',
          beatIds: ['beat_2'],
          eventIds: ['ev_2'],
          sourceParagraphIds: ['p2'],
          locationId: 'loc_steps',
          interiorExterior: 'exterior',
          timeOfDay: '清晨',
          characterIds: [char1Id, char2Id],
          propIds: [],
          blocks: [
            { id: 'b_4', type: 'action', text: '一道白衣胜雪的绝美身影翩然自云端落下。' },
            { id: 'b_5', type: 'dialogue', characterId: char2Id, text: '心有杂念者，纵至山门亦不得入。' },
            { id: 'b_6', type: 'voiceover', characterId: char1Id, text: '这女子宛如画中谪仙……' },
          ],
          estimatedDurationSec: 55,
        },
      ],
    };

    // Save manually
    const saved = await ScriptService.saveManualScript({
      scriptId: script.id,
      document: doc,
      expectedRevision: 1,
    });

    assert.equal(saved.revision, 2);
    assert.equal(saved.document.title, '青云第一战');
    assert.equal(saved.document.scenes.length, 2);

    // Completeness validation check
    const validation = validateScriptForConfirmation(saved.document);
    assert.equal(validation.valid, true);
    assert.equal(validation.errors.length, 0);

    // Markdown serialization
    const md = await ScriptService.exportScriptMarkdown(script.id);
    assert.ok(md.includes('# 青云第一战'));
    assert.ok(md.includes('**一句话梗概**：林轩拜入青云门'));
    assert.ok(md.includes('**结尾钩子 (Ending Hook)**：山门钟声突然大作'));
    assert.ok(md.includes('第 1 场：问仙石阶 · 外景 · 清晨'));
    assert.ok(md.includes('【动作】晨雾弥漫，林轩气喘吁吁'));
    assert.ok(md.includes('**林轩**（抹去额头汗珠）：九千九百九十九级'));
    assert.ok(md.includes('【音效】微风拂过竹林的沙沙声。'));
    assert.ok(md.includes('**陆雪琪**：心有杂念者，纵至山门亦不得入。'));
    assert.ok(md.includes('【画外音·林轩】这女子宛如画中谪仙'));

    // Outline is distinct from scenes
    assert.notEqual(saved.document.outline, undefined);
    assert.equal(saved.document.scenes[0]?.id, 'sc_01');
  });

  await t.test('SC04: Concurrency revision conflict and chapter target isolation', async () => {
    const fixture = await createTestFixture();
    const script = await ScriptService.createOrGetScript(fixture.chapterId);
    assert.equal(script.revision, 1);

    // Tab 1 updates to revision 2
    const doc = createEmptyScriptDocument('Tab 1 Title');
    const updatedByTab1 = await ScriptService.saveManualScript({
      scriptId: script.id,
      document: doc,
      expectedRevision: 1,
    });
    assert.equal(updatedByTab1.revision, 2);

    // Tab 2 tries to update with stale revision 1 -> 409 Conflict
    await assert.rejects(
      async () => {
        await ScriptService.saveManualScript({
          scriptId: script.id,
          document: createEmptyScriptDocument('Tab 2 Title'),
          expectedRevision: 1,
        });
      },
      (err: any) => {
        assert.ok(err instanceof ScriptServiceError);
        assert.equal(err.statusCode, 409);
        assert.ok(err.message.includes('Revision conflict'));
        return true;
      }
    );

    // Tab 2 tries to confirm with stale revision 1 -> 409 Conflict
    await assert.rejects(
      async () => {
        await ScriptService.confirmScript({
          scriptId: script.id,
          expectedRevision: 1,
        });
      },
      (err: any) => {
        assert.ok(err instanceof ScriptServiceError);
        assert.equal(err.statusCode, 409);
        return true;
      }
    );
  });

  await t.test('SC05: Source content & context change freshness auditing', async () => {
    const fixture = await createTestFixture('初始小说章节文字');
    const script = await ScriptService.createOrGetScript(fixture.chapterId);

    // Initially fresh
    const initialDetails = await ScriptService.getScriptById(script.id);
    assert.equal(initialDetails.freshness.sourceChanged, false);
    assert.equal(initialDetails.freshness.contentChanged, false);
    assert.equal(initialDetails.freshness.contextChanged, false);

    // Add 2 valid scenes so confirmation is possible
    const docWithScenes: ScriptDocument = {
      ...script.document,
      locations: [{ id: 'loc1', name: '修炼密室', description: '' }],
      scenes: [
        {
          id: 'sc_valid_1',
          beatIds: [],
          eventIds: [],
          sourceParagraphIds: [],
          locationId: 'loc1',
          interiorExterior: 'interior',
          timeOfDay: 'day',
          characterIds: [],
          propIds: [],
          blocks: [{ id: 'b_v1', type: 'action', text: '林轩打坐修炼。' }],
        },
      ],
    };
    await ScriptService.saveManualScript({
      scriptId: script.id,
      document: docWithScenes,
      expectedRevision: 1,
    });

    // Create a pending candidate against revision 2
    const candidate = await ScriptService.createPendingCandidate({
      scriptId: script.id,
      kind: 'script',
      expectedRevision: 2,
      requestKey: 'req_candidate_1',
      afterJson: JSON.stringify(docWithScenes),
    });
    assert.equal(candidate.state, 'pending');

    // Mutate novel text in database
    await db.run(
      `UPDATE chapter SET content = '修改后的小说正文内容，增加了新的剧情伏笔。' WHERE id = ?`,
      fixture.chapterId
    );

    // Freshness now detects content change!
    const staleDetails = await ScriptService.getScriptById(script.id);
    assert.equal(staleDetails.freshness.sourceChanged, true);
    assert.equal(staleDetails.freshness.contentChanged, true);

    // Applying candidate when sourceChanged must be rejected with 409
    await assert.rejects(
      async () => {
        await ScriptService.applyCandidate({
          scriptId: script.id,
          changeId: candidate.id,
          expectedRevision: 2,
        });
      },
      (err: any) => {
        assert.ok(err instanceof ScriptServiceError);
        assert.equal(err.statusCode, 409);
        assert.ok(err.message.includes('Source novel content or project context has changed'));
        return true;
      }
    );

    // Confirming script without force_source_refresh must be rejected with 409
    await assert.rejects(
      async () => {
        await ScriptService.confirmScript({
          scriptId: script.id,
          expectedRevision: 2,
          forceSourceRefresh: false,
        });
      },
      (err: any) => {
        assert.ok(err instanceof ScriptServiceError);
        assert.equal(err.statusCode, 409);
        assert.ok(err.message.includes('has changed since script creation'));
        return true;
      }
    );

    // Confirming script with forceSourceRefresh: true succeeds and updates snapshot!
    const refreshed = await ScriptService.confirmScript({
      scriptId: script.id,
      expectedRevision: 2,
      forceSourceRefresh: true,
    });
    assert.equal(refreshed.status, 'confirmed');
    assert.equal(refreshed.revision, 3);
    assert.equal(refreshed.freshness.sourceChanged, false);
    assert.equal(refreshed.freshness.contentChanged, false);

    // Now test semantic context change (adding a character to project)
    await db.run(
      `INSERT INTO character (project_id, name, role) VALUES (?, '万剑一', '长老')`,
      fixture.projId
    );

    const contextChangedDetails = await ScriptService.getScriptById(script.id);
    assert.equal(contextChangedDetails.freshness.sourceChanged, true);
    assert.equal(contextChangedDetails.freshness.contextChanged, true);
    assert.equal(contextChangedDetails.freshness.contentChanged, false);
  });

  await t.test('Candidate lifecycle: idempotency, edit, discard, apply', async () => {
    const fixture = await createTestFixture();
    const script = await ScriptService.createOrGetScript(fixture.chapterId);

    const testDoc = createEmptyScriptDocument('候选剧本测试');
    testDoc.locations = [{ id: 'loc_x', name: '偏厅', description: '烛火昏暗的偏厅' }];
    testDoc.scenes = [
      {
        id: 'sc_cand_1',
        beatIds: [],
        eventIds: [],
        sourceParagraphIds: [],
        locationId: 'loc_x',
        interiorExterior: 'interior',
        timeOfDay: 'night',
        characterIds: [],
        propIds: [],
        blocks: [{ id: 'b_c1', type: 'action', text: '烛火摇曳。' }],
      },
    ];

    // Create candidate
    const c1 = await ScriptService.createPendingCandidate({
      scriptId: script.id,
      kind: 'script',
      expectedRevision: 1,
      requestKey: 'same_req_key',
      afterJson: JSON.stringify(testDoc),
    });

    // Idempotent creation with same request_key
    const c2 = await ScriptService.createPendingCandidate({
      scriptId: script.id,
      kind: 'script',
      expectedRevision: 1,
      requestKey: 'same_req_key',
      afterJson: JSON.stringify(testDoc),
    });
    assert.equal(c1.id, c2.id);

    // Edit pending candidate
    testDoc.title = '编辑后的候选标题';
    const updatedCand = await ScriptService.updatePendingCandidate({
      scriptId: script.id,
      changeId: c1.id,
      expectedRevision: 1,
      afterJson: JSON.stringify(testDoc),
    });
    assert.ok(updatedCand.after_json?.includes('编辑后的候选标题'));

    // Apply candidate
    const applied = await ScriptService.applyCandidate({
      scriptId: script.id,
      changeId: c1.id,
      expectedRevision: 1,
    });
    assert.equal(applied.revision, 2);
    assert.equal(applied.document.title, '编辑后的候选标题');

    // Repeated apply is idempotent
    const reapply = await ScriptService.applyCandidate({
      scriptId: script.id,
      changeId: c1.id,
      expectedRevision: 2,
    });
    assert.equal(reapply.revision, 2);

    // Discard a new candidate
    const c3 = await ScriptService.createPendingCandidate({
      scriptId: script.id,
      kind: 'outline',
      expectedRevision: 2,
      requestKey: 'req_discard_test',
      afterJson: JSON.stringify({ logline: '待丢弃' }),
    });
    assert.equal(c3.state, 'pending');

    const discarded = await ScriptService.discardCandidate({
      scriptId: script.id,
      changeId: c3.id,
    });
    assert.equal(discarded.state, 'discarded');

    // Cannot apply discarded candidate
    await assert.rejects(
      async () => {
        await ScriptService.applyCandidate({
          scriptId: script.id,
          changeId: c3.id,
          expectedRevision: 2,
        });
      },
      (err: any) => {
        assert.ok(err instanceof ScriptServiceError);
        assert.equal(err.statusCode, 409);
        return true;
      }
    );
  });

  await t.test('SC02: Strict reference validation on confirmScript (character ownership, cast, locations)', async () => {
    const fixture = await createTestFixture();
    const script = await ScriptService.createOrGetScript(fixture.chapterId);

    // 1. Scene referencing a locationId not in doc.locations
    const invalidLocDoc: ScriptDocument = {
      ...script.document,
      locations: [{ id: 'loc_real', name: '真实地点', description: '' }],
      scenes: [
        {
          id: 'sc_inv_loc',
          beatIds: [],
          eventIds: [],
          sourceParagraphIds: [],
          locationId: 'loc_fake', // Not declared in locations!
          interiorExterior: 'interior',
          timeOfDay: 'day',
          characterIds: [fixture.charId],
          propIds: [],
          blocks: [{ id: 'b_1', type: 'action', text: '行动。' }],
        },
      ],
    };
    // Save manual script schema check catches it
    await assert.rejects(
      async () => {
        await ScriptService.saveManualScript({
          scriptId: script.id,
          document: invalidLocDoc,
          expectedRevision: 1,
        });
      },
      (err: any) => {
        assert.ok(err instanceof ScriptServiceError);
        assert.equal(err.statusCode, 400);
        assert.ok(err.message.includes('未在剧本地点列表 (locations) 中声明'));
        return true;
      }
    );

    // 2. Dialogue character not in scene cast
    const invalidCastDoc: ScriptDocument = {
      ...script.document,
      locations: [{ id: 'loc_real', name: '真实地点', description: '' }],
      scenes: [
        {
          id: 'sc_inv_cast',
          beatIds: [],
          eventIds: [],
          sourceParagraphIds: [],
          locationId: 'loc_real',
          interiorExterior: 'interior',
          timeOfDay: 'day',
          characterIds: [], // Empty cast!
          propIds: [],
          blocks: [{ id: 'b_dia_1', type: 'dialogue', characterId: fixture.charId, text: '你好。' }],
        },
      ],
    };
    await assert.rejects(
      async () => {
        await ScriptService.saveManualScript({
          scriptId: script.id,
          document: invalidCastDoc,
          expectedRevision: 1,
        });
      },
      (err: any) => {
        assert.ok(err instanceof ScriptServiceError);
        assert.equal(err.statusCode, 400);
        assert.ok(err.message.includes('未包含在当前分场出场角色名单 (characterIds) 中'));
        return true;
      }
    );

    // 3. Dialogue character 999999 not in project character center
    const unknownCharDoc: ScriptDocument = {
      ...script.document,
      locations: [{ id: 'loc_real', name: '真实地点', description: '' }],
      scenes: [
        {
          id: 'sc_inv_char',
          beatIds: [],
          eventIds: [],
          sourceParagraphIds: [],
          locationId: 'loc_real',
          interiorExterior: 'interior',
          timeOfDay: 'day',
          characterIds: [999999],
          propIds: [],
          blocks: [{ id: 'b_dia_2', type: 'dialogue', characterId: 999999, text: '你是谁？' }],
        },
      ],
    };
    // Save succeeds (as character center is dynamic in DB), but confirmScript MUST reject with 400!
    const savedUnknown = await ScriptService.saveManualScript({
      scriptId: script.id,
      document: unknownCharDoc,
      expectedRevision: 1,
    });
    assert.equal(savedUnknown.revision, 2);

    await assert.rejects(
      async () => {
        await ScriptService.confirmScript({
          scriptId: script.id,
          expectedRevision: 2,
        });
      },
      (err: any) => {
        assert.ok(err instanceof ScriptServiceError);
        assert.equal(err.statusCode, 400);
        assert.ok(err.message.includes('不属于当前项目角色中心'));
        return true;
      }
    );
  });

  await t.test('SC04 / P2-5: Candidate revision conflict control on pending candidate editing', async () => {
    const fixture = await createTestFixture();
    const script = await ScriptService.createOrGetScript(fixture.chapterId);

    const testDoc = createEmptyScriptDocument('候选冲突测试');
    testDoc.locations = [{ id: 'loc_1', name: '大殿', description: '' }];
    testDoc.scenes = [
      {
        id: 'sc_1',
        beatIds: [],
        eventIds: [],
        sourceParagraphIds: [],
        locationId: 'loc_1',
        interiorExterior: 'interior',
        timeOfDay: 'day',
        characterIds: [],
        propIds: [],
        blocks: [{ id: 'b_1', type: 'action', text: '大殿寂静。' }],
      },
    ];

    // Create candidate: base_revision=1, candidate_revision=2
    const cand = await ScriptService.createPendingCandidate({
      scriptId: script.id,
      kind: 'script',
      expectedRevision: 1,
      requestKey: 'req_conflict_test',
      afterJson: JSON.stringify(testDoc),
    });
    assert.equal(cand.candidate_revision, 2);

    // Edit 1: passing expectedCandidateRevision=2 succeeds and increments candidate_revision to 3
    const edited1 = await ScriptService.updatePendingCandidate({
      scriptId: script.id,
      changeId: cand.id,
      expectedRevision: 1,
      expectedCandidateRevision: 2,
      afterJson: JSON.stringify({ ...testDoc, title: '编辑第1版' }),
    });
    assert.equal(edited1.candidate_revision, 3);

    // Edit 2 (concurrent tab holding old candidate_revision=2): must reject with 409 Conflict
    await assert.rejects(
      async () => {
        await ScriptService.updatePendingCandidate({
          scriptId: script.id,
          changeId: cand.id,
          expectedRevision: 1,
          expectedCandidateRevision: 2, // Outdated! Current is 3
          afterJson: JSON.stringify({ ...testDoc, title: '并发覆盖试图' }),
        });
      },
      (err: any) => {
        assert.ok(err instanceof ScriptServiceError);
        assert.equal(err.statusCode, 409);
        assert.ok(err.message.includes('Revision conflict: candidate revision is 3, but expected 2'));
        return true;
      }
    );

    // Edit 3: passing expectedCandidateRevision=3 succeeds and increments candidate_revision to 4
    const edited2 = await ScriptService.updatePendingCandidate({
      scriptId: script.id,
      changeId: cand.id,
      expectedRevision: 1,
      expectedCandidateRevision: 3,
      afterJson: JSON.stringify({ ...testDoc, title: '编辑第2版' }),
    });
    assert.equal(edited2.candidate_revision, 4);

    // Apply with mismatched expectedCandidateRevision=3 fails with 409
    await assert.rejects(
      async () => {
        await ScriptService.applyCandidate({
          scriptId: script.id,
          changeId: cand.id,
          expectedRevision: 1,
          expectedCandidateRevision: 3, // Outdated! Current is 4
        });
      },
      (err: any) => {
        assert.ok(err instanceof ScriptServiceError);
        assert.equal(err.statusCode, 409);
        return true;
      }
    );

    // Apply with expectedCandidateRevision=4 succeeds
    const applied = await ScriptService.applyCandidate({
      scriptId: script.id,
      changeId: cand.id,
      expectedRevision: 1,
      expectedCandidateRevision: 4,
    });
    assert.equal(applied.revision, 2);
    assert.equal(applied.document.title, '编辑第2版');
  });

  await t.test('P1-1: Reject invalid candidate payloads on creation, update, and apply', async () => {
    const fixture = await createTestFixture();
    const script = await ScriptService.createOrGetScript(fixture.chapterId);

    // 1. Invalid outline payload (e.g. beats is a string, not an array)
    await assert.rejects(
      async () => {
        await ScriptService.createPendingCandidate({
          scriptId: script.id,
          kind: 'outline',
          expectedRevision: 1,
          requestKey: 'req_invalid_outline_create',
          afterJson: JSON.stringify({ beats: 'invalid_string' }),
        });
      },
      (err: any) => {
        assert.ok(err instanceof ScriptServiceError);
        assert.equal(err.statusCode, 400);
        assert.ok(err.message.includes('Invalid outline candidate payload'));
        return true;
      }
    );

    // 2. Invalid scene payload (e.g. missing id)
    await assert.rejects(
      async () => {
        await ScriptService.createPendingCandidate({
          scriptId: script.id,
          kind: 'scene',
          expectedRevision: 1,
          requestKey: 'req_invalid_scene_create',
          afterJson: JSON.stringify({ blocks: [] }), // Missing id!
        });
      },
      (err: any) => {
        assert.ok(err instanceof ScriptServiceError);
        assert.equal(err.statusCode, 400);
        assert.ok(err.message.includes('Invalid scene candidate payload'));
        return true;
      }
    );

    // 3. Create valid candidate then attempt update with invalid payload
    const validCandidate = await ScriptService.createPendingCandidate({
      scriptId: script.id,
      kind: 'outline',
      expectedRevision: 1,
      requestKey: 'req_valid_outline',
      afterJson: JSON.stringify({ logline: '正常提纲', beats: [] }),
    });

    await assert.rejects(
      async () => {
        await ScriptService.updatePendingCandidate({
          scriptId: script.id,
          changeId: validCandidate.id,
          expectedRevision: 1,
          afterJson: JSON.stringify({ mustKeepEvents: 'invalid' }),
        });
      },
      (err: any) => {
        assert.ok(err instanceof ScriptServiceError);
        assert.equal(err.statusCode, 400);
        assert.ok(err.message.includes('Invalid outline payload'));
        return true;
      }
    );
  });

  await t.test('Issue 2: refreshSourceSnapshot validates revision inside transaction against concurrent writes', async () => {
    const fixture = await createTestFixture();
    const script = await ScriptService.createOrGetScript(fixture.chapterId);
    assert.equal(script.revision, 1);

    const docToSave = {
      ...script.document,
      title: '并发保存测试剧本',
    };

    // Concurrently execute saveManualScript and refreshSourceSnapshot with expectedRevision 1
    const p1 = ScriptService.saveManualScript({
      scriptId: script.id,
      document: docToSave,
      expectedRevision: 1,
    });
    const p2 = ScriptService.refreshSourceSnapshot({
      scriptId: script.id,
      expectedRevision: 1,
    });

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one must succeed and one must be rejected with 409
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    const rejReason = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(rejReason instanceof ScriptServiceError);
    assert.equal(rejReason.statusCode, 409);
    assert.ok(rejReason.message.includes('Revision conflict'));

    // The script revision must now be 2
    const current = await ScriptService.getScriptById(script.id);
    assert.equal(current.revision, 2);

    // Subsequent operation with expectedRevision 2 succeeds
    const nextRes = await ScriptService.refreshSourceSnapshot({
      scriptId: script.id,
      expectedRevision: 2,
    });
    assert.equal(nextRes.revision, 3);
  });

  await t.test('Issue 3: Stale base revision cannot overwrite remote tab changes', async () => {
    const fixture = await createTestFixture();
    const script = await ScriptService.createOrGetScript(fixture.chapterId);
    assert.equal(script.revision, 1);

    // Tab A buffer is based on revision 1
    const tabABuffer = {
      ...script.document,
      title: 'Tab A 未保存草稿',
    };

    // Tab B saves new edits to server, advancing revision to 2
    const tabBDoc = {
      ...script.document,
      title: 'Tab B 已保存正稿',
    };
    const tabBSave = await ScriptService.saveManualScript({
      scriptId: script.id,
      document: tabBDoc,
      expectedRevision: 1,
    });
    assert.equal(tabBSave.revision, 2);

    // Tab A now attempts to save its dirty buffer (which had base revision 1)
    await assert.rejects(
      async () => {
        await ScriptService.saveManualScript({
          scriptId: script.id,
          document: tabABuffer,
          expectedRevision: 1, // Base revision of Tab A's buffer
        });
      },
      (err: any) => {
        assert.ok(err instanceof ScriptServiceError);
        assert.equal(err.statusCode, 409);
        assert.ok(err.message.includes('Revision conflict'));
        return true;
      }
    );

    // Tab B's content remains safe and un-clobbered
    const finalDoc = await ScriptService.getScriptById(script.id);
    assert.equal(finalDoc.document.title, 'Tab B 已保存正稿');
    assert.equal(finalDoc.revision, 2);
  });

  await t.test('Scene apply restores the full document and rejects a mismatched scene id', async () => {
    const fixture = await createTestFixture();
    const script = await ScriptService.createOrGetScript(fixture.chapterId);
    const baseDoc: ScriptDocument = {
      ...script.document,
      title: '两场原稿',
      locations: [{ id: 'loc_hall', name: '大殿', description: '' }],
      scenes: [
        {
          id: 'sc_keep',
          beatIds: [],
          eventIds: [],
          sourceParagraphIds: [],
          locationId: 'loc_hall',
          interiorExterior: 'interior',
          timeOfDay: 'day',
          characterIds: [fixture.charId],
          propIds: [],
          blocks: [{ id: 'b_keep', type: 'action', text: '第一场保持不变' }],
        },
        {
          id: 'sc_edit',
          beatIds: [],
          eventIds: [],
          sourceParagraphIds: [],
          locationId: 'loc_hall',
          interiorExterior: 'interior',
          timeOfDay: 'day',
          characterIds: [fixture.charId],
          propIds: [],
          blocks: [{ id: 'b_edit', type: 'action', text: '第二场原文' }],
        },
      ],
    };
    const saved = await ScriptService.saveManualScript({
      scriptId: script.id,
      document: baseDoc,
      expectedRevision: 1,
    });

    const rewrittenScene = {
      ...baseDoc.scenes[1],
      blocks: [{ id: 'b_edit', type: 'action' as const, text: '第二场改写' }],
    };
    const candidate = await ScriptService.createPendingCandidate({
      scriptId: saved.id,
      kind: 'scene',
      expectedRevision: saved.revision,
      requestKey: 'req_scene_restore',
      afterJson: JSON.stringify(rewrittenScene),
      beforeJson: JSON.stringify(baseDoc.scenes[1]),
      generationInfo: { target_scene_id: 'sc_edit' },
    });
    const applied = await ScriptService.applyCandidate({
      scriptId: saved.id,
      changeId: candidate.id,
      expectedRevision: saved.revision,
    });
    assert.equal(applied.document.scenes[0]?.blocks[0]?.text, '第一场保持不变');
    assert.equal(applied.document.scenes[1]?.blocks[0]?.text, '第二场改写');
    assert.equal(applied.document.scenes.length, 2);

    const stored = (await db.get(
      'SELECT before_json FROM script_change WHERE id = ?',
      candidate.id
    )) as { before_json: string };
    const storedBefore = JSON.parse(stored.before_json);
    assert.equal(storedBefore.schemaVersion, 1);
    assert.equal(storedBefore.scenes.length, 2);

    const restored = await ScriptService.restoreScript({
      scriptId: saved.id,
      expectedRevision: applied.revision,
    });
    assert.equal(restored.document.scenes[1]?.blocks[0]?.text, '第二场原文');
    assert.equal(restored.document.scenes[0]?.blocks[0]?.text, '第一场保持不变');

    const refreshed = await ScriptService.refreshSourceSnapshot({
      scriptId: saved.id,
      expectedRevision: restored.revision,
    });
    const restoredAfterRefresh = await ScriptService.restoreScript({
      scriptId: saved.id,
      expectedRevision: refreshed.revision,
    });
    assert.equal(restoredAfterRefresh.document.scenes[1]?.blocks[0]?.text, '第二场改写');

    const mismatch = await ScriptService.createPendingCandidate({
      scriptId: saved.id,
      kind: 'scene',
      expectedRevision: restoredAfterRefresh.revision,
      requestKey: 'req_scene_mismatch',
      afterJson: JSON.stringify({ ...rewrittenScene, id: 'sc_other' }),
      beforeJson: JSON.stringify(rewrittenScene),
      generationInfo: { target_scene_id: 'sc_edit' },
    });
    await assert.rejects(
      () =>
        ScriptService.applyCandidate({
          scriptId: saved.id,
          changeId: mismatch.id,
          expectedRevision: restoredAfterRefresh.revision,
        }),
      (err: any) => {
        assert.equal(err.statusCode, 409);
        return true;
      }
    );
    const unchanged = await ScriptService.getScriptById(saved.id);
    assert.equal(unchanged.revision, restoredAfterRefresh.revision);
    assert.equal(unchanged.document.scenes.length, 2);
  });
});
