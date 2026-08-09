import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentActionSchema,
  AgentOsDecisionSchema,
  needsConfirmation,
} from './agent_os';

test('parses structure and skill actions', () => {
  const rename = AgentActionSchema.parse({
    op: 'RENAME_CHAPTER',
    chapterId: 'ch-1',
    newTitle: '决战',
  });
  assert.equal(rename.op, 'RENAME_CHAPTER');

  const skill = AgentActionSchema.parse({
    op: 'CINEMATIC_REWRITE',
    technique: 'sensory',
    instructions: 'more rain',
  });
  assert.equal(skill.op, 'CINEMATIC_REWRITE');
});

test('decision schema and confirmation flags', () => {
  const d = AgentOsDecisionSchema.parse({
    thought: 'rename',
    response: '将重命名章节',
    actions: [
      { op: 'RENAME_CHAPTER', chapterId: 'a', newTitle: 'B' },
      { op: 'ANSWER_QUESTION', answer: 'ok' },
    ],
  });
  assert.equal(d.actions.length, 2);
  assert.equal(needsConfirmation(d.actions), true);
  assert.equal(
    needsConfirmation([{ op: 'ANSWER_QUESTION' }]),
    false
  );
});
