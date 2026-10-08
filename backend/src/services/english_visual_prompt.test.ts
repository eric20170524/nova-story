import '../test_setup';
import assert from 'node:assert/strict';
import test from 'node:test';
import { LLMService } from './llm';
import {
  actionOverridesWardrobe,
  assertEnglishFidelity,
  compileEnglishShotPrompt,
  draftEnglishFromCues,
  englishCoversCues,
  extractVisibleBeats,
  optimizeOutboundPrompt,
  setVisualPromptTranslatorForTests,
  setVisualPromptVerifierForTests,
  stripPeopleBlockers,
  stripWardrobeTokens,
  assetPromptForShot,
} from './english_visual_prompt';

const cueTranslator = async (prompt: string) => draftEnglishFromCues(prompt) || 'adult figures, visible action preserved';
test.beforeEach(() => setVisualPromptVerifierForTests(async (facts, english) => ({
  facts: facts.map((_, id) => ({ id, status: /poetic|soft moonlight|quiet emotional|tendril only/.test(english) ? 'missing' : 'preserved', evidence: english })),
})));
test.afterEach(() => {
  setVisualPromptTranslatorForTests(null);
  setVisualPromptVerifierForTests(null);
});

test('visible cues must survive the English prompt', async () => {
  const source = '成年陆尘穿着白色长袍，摘下手套并拥抱青檀';
  assert.equal(await englishCoversCues(source, 'adult, robe, removes, glove, embrace'), true);
  assert.equal(await englishCoversCues(source, 'soft moonlight and a poetic mood'), false);
  await assert.rejects(() => assertEnglishFidelity(source, 'soft moonlight'));
  assert.deepEqual(draftEnglishFromCues(source).split(', '), ['embrace', 'robe', 'glove', 'removes', 'adult']);
});

test('spread legs stay a visible cue when the wording is 双腿大张', async () => {
  assert.equal(await englishCoversCues('双腿大张承受触腕', 'legs spread, tendril'), true);
  assert.equal(await englishCoversCues('双腿大张承受触腕', 'tendril only'), false);
});

test('visible beats quote source sentences and prefer strong cues', () => {
  const beats = extractVisibleBeats([
    { id: 'p_1', text: '他吻了她。她褪下外袍，跨坐在他身上。林轩入殿。' },
  ]);
  assert.deepEqual(beats.map((beat) => beat.text), ['她褪下外袍，跨坐在他身上', '他吻了她']);
  assert.deepEqual(beats[0]?.sourceParagraphIds, ['p_1']);
  assert.equal(beats[0]?.id, 'vb_1');
  const many = extractVisibleBeats([
    { id: 'p_2', text: Array.from({ length: 18 }, (_, index) => `她第${index}次跨坐`).join('。') },
  ]);
  assert.equal(many.length, 16);
});

test('wardrobe tags yield to the shot clothing state, and empty-scene blockers stay out', () => {
  assert.equal(actionOverridesWardrobe('红衣褪至腰，手指探入衣襟'), true);
  assert.equal(actionOverridesWardrobe('她站在殿中'), false);
  assert.equal(
    stripWardrobeTokens('adult woman, full breasts, pale skin, half_unraveled_moon_white, hanfu, white robe lowered'),
    'adult woman, full breasts, pale skin, white robe lowered',
  );
  assert.equal(
    stripPeopleBlockers('palace interior, 16:9, no people, isolated, version one prop prompt'),
    'palace interior, version one prop prompt',
  );
});

test('compiled shot prompts are English and fail closed when visible facts disappear', async () => {
  setVisualPromptTranslatorForTests(cueTranslator);
  try {
    const compiled = await compileEnglishShotPrompt(
      {
        shot_intent: 'establish',
        shot_type: 'Wide Shot',
        location: '山门庭院',
        primary_action: '成年陆尘褪下白色长袍，摘下手套并拥抱青檀',
        primary_subject: '陆尘',
        visible_subjects: ['陆尘'],
        subject_scale: 'medium-20-40',
      },
      [{ name: '陆尘', lock: '1boy, black hair, half_unraveled_moon_white' }],
      { modelFamily: 'redcraft_krea2', nsfwEnabled: true },
    );
    assert.match(compiled.visual_prompt, /robe/i);
    assert.match(compiled.visual_prompt, /glove/i);
    assert.match(compiled.visual_prompt, /embrace/i);
    assert.match(compiled.visual_prompt, /black hair/i);
    assert.doesNotMatch(compiled.visual_prompt, /[\u3400-\u9fff]/);
    assert.doesNotMatch(compiled.visual_prompt, /half_unraveled_moon_white/);

    let seenSystem = '';
    setVisualPromptTranslatorForTests(async (_prompt, system) => {
      seenSystem = system || '';
      return 'An adult removes gloves, wears a robe, and embraces her.';
    });
    await compileEnglishShotPrompt(
      { location: '庭院', primary_action: '成年角色摘下手套拥抱' },
      '',
      { modelFamily: 'redcraft_krea2', nsfwEnabled: true },
    );
    assert.match(seenSystem, /2 to 4 natural English sentences/);
    assert.match(seenSystem, /NSFW: on/);

    setVisualPromptTranslatorForTests(async () => 'soft moonlight and poetic atmosphere');
    await assert.rejects(
      () => compileEnglishShotPrompt({ location: '清暮宫', primary_action: '她跨坐在他身上' }, ''),
      /dropped visible facts/,
    );

    setVisualPromptTranslatorForTests(async () => '她跨坐 straddling');
    await assert.rejects(
      () => compileEnglishShotPrompt({ location: '清暮宫', primary_action: '她跨坐在他身上' }, ''),
      /Chinese characters/,
    );
  } finally {
    setVisualPromptTranslatorForTests(null);
  }
});

test('outbound optimization keeps an English prompt and does not accept a cue-dropping rewrite', async () => {
  setVisualPromptTranslatorForTests(cueTranslator);
  try {
    const english = await optimizeOutboundPrompt('hero in the old temple, version one prop prompt', { modelFamily: 'pony' });
    assert.equal(english, 'hero in the old temple, version one prop prompt');
    const blocked = await optimizeOutboundPrompt('palace interior, 16:9, no people, isolated', { modelFamily: 'pony' });
    assert.equal(blocked, 'palace interior, 16:9, no people, isolated');
    const undressed = await optimizeOutboundPrompt(
      'robe lowered to the waist, full breasts, half_unraveled_moon_white',
      { modelFamily: 'redcraft_krea2' },
    );
    assert.match(undressed, /robe lowered to the waist/);
    assert.match(undressed, /full breasts/);
    assert.doesNotMatch(undressed, /half_unraveled_moon_white/);

    const translated = await optimizeOutboundPrompt('她跨坐在他身上，胸前相贴', { modelFamily: 'pony', nsfwEnabled: true });
    assert.match(translated, /straddl/i);
    assert.match(translated, /breast|chest/i);
    assert.doesNotMatch(translated, /[\u3400-\u9fff]/);

    setVisualPromptTranslatorForTests(async () => 'a quiet emotional atmosphere');
    await assert.rejects(
      () => optimizeOutboundPrompt('她跨坐在他身上', { modelFamily: 'pony' }),
      /dropped visible/,
    );
  } finally {
    setVisualPromptTranslatorForTests(null);
  }
});

test('semantic fidelity rejects reversed clothing and facts outside the glossary', async () => {
  const cases = [
    { source: '她脱掉外袍', english: 'A woman wearing a robe stands beside an open window.', status: 'contradicted' as const },
    { source: '她穿着红色夹克，双手交叉', english: 'A woman stands by a window.', status: 'missing' as const },
    { source: '她摘下手套并拥抱来客', english: 'The visitor removes gloves and embraces her.', status: 'contradicted' as const },
  ];
  for (const item of cases) {
    setVisualPromptVerifierForTests(async (facts, english) => {
      assert.equal(facts.join('，'), item.source);
      assert.equal(english, item.english);
      return { facts: facts.map((_, id) => ({ id, status: item.status, evidence: english })) };
    });
    assert.equal(await englishCoversCues(item.source, item.english), false);
  }
});

test('shot clothing and a half-open door survive an auditor that mislabels them', async () => {
  const source = '陆嘉静端坐如宫主般脊背挺直，月白里衣半敞，锁骨下仙纹随呼吸明灭，正解外袍举行仪式。 with 合欢香，清暮宫内殿 in soft background，门扉半掩隔绝尘世 in soft background，陆嘉静 appearance: long_silky_white';
  const english = 'She sits with her spine perfectly straight while partially unbuttoning her moon-white undergarment. She begins to remove her outer robe for a ritual while the scent of Joyous Union perfume lingers. The background is the inner hall, where half-open doors suggest the separation from the mortal world. long, silky white hair.';
  setVisualPromptVerifierForTests(async () => ({
    facts: [
      { id: 0, status: 'preserved', evidence: 'sits with her spine perfectly straight' },
      { id: 1, status: 'contradicted', evidence: 'partially unbuttoning her moon-white undergarment' },
      { id: 2, status: 'preserved', evidence: 'moon-white undergarment' },
      { id: 3, status: 'preserved', evidence: 'begins to remove her outer robe for a ritual' },
      { id: 4, status: 'missing', evidence: '' },
      { id: 5, status: 'preserved', evidence: 'inner hall' },
      { id: 6, status: 'missing', evidence: '' },
      { id: 7, status: 'contradicted', evidence: 'long, silky white hair' },
    ],
  }));
  await assertEnglishFidelity(source, english);
});

test('production fidelity path audits every clause with relational instructions', async () => {
  setVisualPromptVerifierForTests(null);
  const provider = LLMService.getLocalProvider();
  const originalProviderFactory = LLMService.getLocalProvider;
  LLMService.getLocalProvider = () => provider;
  const original = provider.generateStructured;
  let calls = 0;
  provider.generateStructured = async (prompt, schema, system) => {
    calls++;
    const request = JSON.parse(prompt);
    assert.deepEqual(request.sourceFacts, [{ id: 0, fact: '她穿着红色夹克' }, { id: 1, fact: '双手交叉' }]);
    assert.match(system || '', /subject, action, object, color, clothing state/);
    assert.match(system || '', /wearing a robe contradicts removing it/);
    return schema.parse({ facts: [
      { id: 0, status: 'preserved', evidence: 'red jacket' },
      { id: 1, status: 'missing', evidence: '' },
    ] });
  };
  try {
    await assert.rejects(() => assertEnglishFidelity('她穿着红色夹克，双手交叉', 'A woman in a red jacket.'), /dropped visible facts/);
    assert.equal(calls, 1);
  } finally {
    provider.generateStructured = original;
    LLMService.getLocalProvider = originalProviderFactory;
  }
});

test('semantic audit fails closed on incomplete, duplicate, or invented evidence', async () => {
  for (const facts of [
    [],
    [{ id: 0, status: 'preserved' as const, evidence: 'A woman.' }, { id: 0, status: 'preserved' as const, evidence: 'A woman.' }],
    [{ id: 0, status: 'preserved' as const, evidence: 'red jacket' }],
  ]) {
    setVisualPromptVerifierForTests(async () => ({ facts }));
    await assert.rejects(() => assertEnglishFidelity('她穿着红色夹克', 'A woman.'), /dropped visible facts/);
  }
});

test('failed fidelity never poisons the retry cache; validated translations can be reused', async () => {
  let calls = 0;
  setVisualPromptTranslatorForTests(async () => ++calls === 1 ? 'A woman wearing a robe.' : 'She removes her robe.');
  setVisualPromptVerifierForTests(async (facts, english) => ({
    facts: facts.map((_, id) => ({ id, status: english.includes('wearing') ? 'contradicted' : 'preserved', evidence: english })),
  }));
  const contract = { location: '庭院', primary_action: '她脱掉外袍' };
  await assert.rejects(() => compileEnglishShotPrompt(contract), /contradicted/);
  const good = await compileEnglishShotPrompt(contract);
  assert.match(good.visual_prompt, /removes her robe/);
  await compileEnglishShotPrompt(contract);
  assert.equal(calls, 2);
});

test('standalone empty locations and isolated props retain their outbound constraints', async () => {
  const asset = 'courtyard, no people, isolated';
  assert.equal(assetPromptForShot(asset, { visible_subjects: ['hero'] }, 'hero walks'), 'courtyard');
  assert.equal(assetPromptForShot(asset, { subject_scale: 'absent' }, 'empty courtyard'), asset);
  assert.equal(assetPromptForShot(asset, { visible_subjects: ['hero'] }, 'no people in the courtyard'), asset);
  assert.equal(assetPromptForShot(asset, {}, 'courtyard'), asset);
  assert.equal(await optimizeOutboundPrompt('empty courtyard, no people'), 'empty courtyard, no people');
  assert.equal(await optimizeOutboundPrompt('a red glove, isolated, no people'), 'a red glove, isolated, no people');
  setVisualPromptTranslatorForTests(async () => 'An empty courtyard, no people, isolated');
  const translated = await optimizeOutboundPrompt('空庭院, no people, isolated');
  assert.match(translated, /no people/);
  assert.match(translated, /isolated/);
});
