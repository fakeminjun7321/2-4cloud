import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFilesLocally, inferEventFromTitle } from './classifyLocal.js';

const subjects = [
  { id: 1, name: '국어' },
  { id: 2, name: '영어' },
  { id: 4, name: '확통' },
  { id: 5, name: '미방' },
  { id: 11, name: '일지1' },
  { id: 12, name: '일지2' },
];
const teachers = [
  { id: 1, subject_id: 1, name: '윤소영' },
  { id: 2, subject_id: 2, name: '이계화' },
  { id: 3, subject_id: 2, name: '김선옥' },
  { id: 4, subject_id: 4, name: '송석준' },
  { id: 5, subject_id: 5, name: '송석준' },
];

test('normalizes NFD Korean and recognizes the real worksheet filename', () => {
  const filename = '국어 학습지.pdf';
  const result = classifyFilesLocally([filename], subjects, teachers);
  assert.equal(result.subject_id, 1);
  assert.equal(result.kind, '학습지');
  assert.equal(result.suggested_title, '국어 학습지');
  assert.equal(result.teacher_id, null);
  assert.equal(result.confidence.subject, 'high');
});

test('uses an exact unique teacher name to infer the subject', () => {
  const result = classifyFilesLocally([{ name: '이계화T-1지문.pdf' }], subjects, teachers);
  assert.equal(result.subject_id, 2);
  assert.equal(result.teacher_id, 2);
  assert.equal(result.confidence.subject, 'medium');
});

test('shared teacher name abstains until an explicit subject disambiguates it', () => {
  const unknown = classifyFilesLocally(['송석준T_필기.pdf'], subjects, teachers);
  assert.equal(unknown.subject_id, null);
  assert.equal(unknown.teacher_id, null);
  assert.ok(unknown.ambiguous.includes('teacher'));
  const known = classifyFilesLocally(['미방_송석준T_필기.pdf'], subjects, teachers);
  assert.equal(known.subject_id, 5);
  assert.equal(known.teacher_id, 5);
});

test('conflicting subject and teacher names do not silently choose one', () => {
  const result = classifyFilesLocally(['국어_이계화T_학습지.pdf'], subjects, teachers);
  assert.equal(result.subject_id, null);
  assert.equal(result.teacher_id, null);
  assert.ok(result.ambiguous.includes('subject'));
  assert.equal(result.kind, '학습지');
});

test('multi-file conflicts abstain per field; matching numbered pages share a title', () => {
  const conflict = classifyFilesLocally(['일지1_필기.pdf', '일지2_학습지.pdf'], subjects, teachers);
  assert.equal(conflict.subject_id, null);
  assert.equal(conflict.kind, null);
  assert.equal(conflict.suggested_title, null);
  const pages = classifyFilesLocally(['국어 학습지 1.png', '국어 학습지 2.png'], subjects, teachers);
  assert.equal(pages.subject_id, 1);
  assert.equal(pages.kind, '학습지');
  assert.equal(pages.suggested_title, '국어 학습지');
});

test('camera names and unsupported generic labels do not invent metadata', () => {
  const result = classifyFilesLocally(['IMG_1234.jpg', '물리_사진.jpg'], subjects, teachers);
  assert.equal(result.subject_id, null);
  assert.equal(result.teacher_id, null);
  assert.equal(result.kind, null);
  assert.equal(result.suggested_title, null);
});

test('calendar title infers only an unambiguous subject, teacher, and type', () => {
  const result = inferEventFromTitle('영어 이계화T 수행평가', subjects, teachers);
  assert.equal(result.subject_id, 2);
  assert.equal(result.teacher_id, 2);
  assert.equal(result.event_type, '수행평가');
});

test('calendar title avoids treating an exam-range notice as an exam', () => {
  const range = inferEventFromTitle('국어 시험범위 안내', subjects, teachers);
  assert.equal(range.subject_id, 1);
  assert.equal(range.event_type, null);
  const conflict = inferEventFromTitle('국어 시험 제출', subjects, teachers);
  assert.equal(conflict.event_type, null);
  assert.ok(conflict.ambiguous.includes('event_type'));
});
