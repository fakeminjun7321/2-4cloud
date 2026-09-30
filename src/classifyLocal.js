// Filename-only suggestions. Nothing here reads or uploads file contents.
// Keep aliases specific: generic labels such as "물리" can name several subjects.
const SUBJECT_ALIASES = {
  국어: ['국어'],
  영어: ['영어'],
  캘큘: ['캘큘', '캘큘러스'],
  확통: ['확통', '확률과통계', '확률과 통계'],
  미방: ['미방', '미분방정식'],
  일물: ['일물', '일반물리', '일반물리학'],
  현물: ['현물', '현대물리', '현대물리학'],
  물실: ['물실', '물리실험', '일반물리학실험'],
  일화: ['일화', '일반화학'],
  프실: ['프실', '프로그래밍실습'],
  일지1: ['일지1', '일반지구과학1'],
  일지2: ['일지2', '일반지구과학2'],
};

const KIND_ALIASES = {
  필기: ['필기', '판서'],
  학습지: ['학습지', '활동지'],
  시험범위: ['시험범위', '시험 범위', '고사범위', '고사 범위'],
};

function canonical(value) {
  return String(value ?? '').normalize('NFC').trim();
}

function filenameOf(file) {
  const value = typeof file === 'string' ? file : file?.name;
  return canonical(value).split(/[/\\]/).at(-1) || '';
}

function stemOf(filename) {
  return filename.replace(/\.(?:pdf|jpe?g|png|webp)$/i, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenPresent(stem, token, suffix = '') {
  const needle = escapeRegExp(canonical(token)).replace(/\s+/g, '[\\s._-]*');
  // Korean words are often joined to a material type ("국어학습지").
  // Otherwise require a complete name, not a substring of an unrelated word.
  const boundary = suffix ? `|${suffix}` : '';
  const expression = new RegExp(`(?:^|[^\\p{L}\\p{N}])${needle}(?=$|[^\\p{L}\\p{N}]${boundary})`, 'iu');
  return expression.test(stem);
}

function teacherPresent(stem, name) {
  return tokenPresent(stem, name, 'T(?=$|[^\\p{L}\\p{N}])|선생님(?=$|[^\\p{L}\\p{N}])');
}

function kindPresent(stem, alias) {
  const compact = stem.replace(/[\s._-]+/g, '').toLocaleLowerCase('ko');
  return compact.includes(canonical(alias).replace(/\s+/g, '').toLocaleLowerCase('ko'));
}

function titleOf(filename) {
  const title = stemOf(filename)
    .replace(/[._-]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title || title.length > 120 || /^(?:img|dsc|pict|photo|scan|screenshot|image|kakao|202\d{5,})[\s\d-]*$/i.test(title)) return null;
  return title;
}

function commonTitle(filenames) {
  const titles = filenames.map(titleOf);
  if (titles.some((title) => !title)) return null;
  if (titles.length === 1) return titles[0];
  const withoutPageNumbers = titles.map((title) => title
    .replace(/\s+(?:(?:page|p|페이지|사진|쪽)\s*)?(?:#\s*)?\d{1,3}$/i, '')
    .trim());
  return withoutPageNumbers.every((title) => title && title === withoutPageNumbers[0])
    ? withoutPageNumbers[0] : null;
}

/**
 * Suggest metadata from selected filenames and the current bootstrap catalog.
 * A null field means it needs human review; this function never applies changes.
 *
 * @param {(File|string)[]} files
 * @param {{id:number, name:string}[]} subjects
 * @param {{id:number, subject_id:number, name:string}[]} teachers
 */
export function classifyFilesLocally(files, subjects, teachers) {
  const filenames = (Array.isArray(files) ? files : []).map(filenameOf).filter(Boolean);
  const stems = filenames.map(stemOf);
  const evidence = [];
  const ambiguous = [];
  const confidence = { subject: null, teacher: null, kind: null, title: null };

  const explicitSubjects = new Set();
  for (const subject of subjects || []) {
    const aliases = SUBJECT_ALIASES[canonical(subject.name)] || [canonical(subject.name)];
    for (let i = 0; i < stems.length; i += 1) {
      const matched = aliases.find((alias) => tokenPresent(stems[i], alias,
        '(?:학습지|활동지|필기|판서|시험범위|고사범위|자료|노트|문제|지문)(?=$|[^\\p{L}\\p{N}]|\\d)|\\d'));
      if (matched) {
        explicitSubjects.add(Number(subject.id));
        evidence.push({ field: 'subject', value: subject.name, filename: filenames[i], matched });
      }
    }
  }

  const matchedTeacherNames = new Set();
  for (const teacher of teachers || []) {
    const name = canonical(teacher.name);
    for (let i = 0; i < stems.length; i += 1) {
      if (teacherPresent(stems[i], name)) {
        matchedTeacherNames.add(name);
        if (!evidence.some((item) => item.field === 'teacher' && item.matched === name && item.filename === filenames[i])) {
          evidence.push({ field: 'teacher', value: name, filename: filenames[i], matched: name });
        }
      }
    }
  }

  let subjectId = null;
  let teacherId = null;
  if (explicitSubjects.size > 1) {
    ambiguous.push('subject');
  } else if (explicitSubjects.size === 1) {
    subjectId = [...explicitSubjects][0];
    confidence.subject = 'high';
  }

  if (matchedTeacherNames.size) {
    const matches = (teachers || []).filter((teacher) => matchedTeacherNames.has(canonical(teacher.name)));
    const teacherSubjects = new Set(matches.map((teacher) => Number(teacher.subject_id)));
    if (subjectId !== null) {
      // A filename that names a teacher from another subject is contradictory.
      if ([...matchedTeacherNames].some((name) => !matches.some((teacher) => canonical(teacher.name) === name && Number(teacher.subject_id) === subjectId))) {
        subjectId = null;
        confidence.subject = null;
        ambiguous.push('subject', 'teacher');
      } else {
        const eligible = matches.filter((teacher) => Number(teacher.subject_id) === subjectId);
        if (eligible.length === 1) {
          teacherId = Number(eligible[0].id);
          confidence.teacher = 'high';
        } else {
          ambiguous.push('teacher');
        }
      }
    } else if (!ambiguous.includes('subject') && teacherSubjects.size === 1) {
      subjectId = [...teacherSubjects][0];
      confidence.subject = 'medium';
      if (matches.length === 1) {
        teacherId = Number(matches[0].id);
        confidence.teacher = 'high';
      } else {
        ambiguous.push('teacher');
      }
    } else {
      ambiguous.push('teacher');
      if (teacherSubjects.size > 1) ambiguous.push('subject');
    }
  }

  const matchedKinds = new Set();
  for (const [kind, aliases] of Object.entries(KIND_ALIASES)) {
    for (let i = 0; i < stems.length; i += 1) {
      const matched = aliases.find((alias) => kindPresent(stems[i], alias));
      if (matched) {
        matchedKinds.add(kind);
        evidence.push({ field: 'kind', value: kind, filename: filenames[i], matched });
      }
    }
  }
  const kind = matchedKinds.size === 1 ? [...matchedKinds][0] : null;
  if (kind) confidence.kind = 'high';
  else if (matchedKinds.size > 1) ambiguous.push('kind');

  const suggestedTitle = commonTitle(filenames);
  if (suggestedTitle) confidence.title = 'medium';
  return {
    source: 'filename',
    subject_id: subjectId,
    teacher_id: teacherId,
    kind,
    suggested_title: suggestedTitle,
    confidence,
    evidence,
    ambiguous: [...new Set(ambiguous)],
  };
}

/** Code-only, read-only hints for the calendar's quick-add form. */
export function inferEventFromTitle(title, subjects, teachers) {
  const normalized = canonical(title);
  const metadata = classifyFilesLocally(normalized ? [normalized] : [], subjects, teachers);
  // "시험범위 안내" is not itself an exam. A conflicting title gets no type.
  const withoutRange = normalized.replace(/(?:시험|고사)\s*범위/g, '');
  const types = new Set();
  if (/(?:중간고사|기말고사|쪽지시험|시험|고사)/.test(withoutRange)) types.add('시험');
  if (/수행\s*평가/.test(normalized)) types.add('수행평가');
  if (/(?:제출|마감)/.test(normalized)) types.add('제출');
  const eventType = types.size === 1 ? [...types][0] : null;
  return {
    source: 'title',
    subject_id: metadata.subject_id,
    teacher_id: metadata.teacher_id,
    event_type: eventType,
    confidence: {
      subject: metadata.confidence.subject,
      teacher: metadata.confidence.teacher,
      event_type: eventType ? 'high' : null,
    },
    evidence: metadata.evidence.filter((item) => item.field !== 'kind'),
    ambiguous: [...new Set([...metadata.ambiguous.filter((field) => field !== 'kind'), ...(types.size > 1 ? ['event_type'] : [])])],
  };
}
