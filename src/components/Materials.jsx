import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './Icons.jsx';
import Modal from './Modal.jsx';

function MaterialForm({ subjects, teachers, refresh, notify, onClose }) {
  const [title, setTitle] = useState('');
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? '');
  const [teacherId, setTeacherId] = useState('');
  const [kind, setKind] = useState('필기');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const eligibleTeachers = teachers.filter((teacher) => teacher.subject_id === Number(subjectId));
  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body = new FormData();
      body.append('title', title);
      body.append('subject_id', subjectId);
      body.append('kind', kind);
      body.append('note', note);
      if (teacherId) body.append('teacher_id', teacherId);
      if (files.length > 24) throw new Error('파일은 한 번에 24개까지 올릴 수 있어요.');
      files.forEach((file) => body.append('files', file));
      await api('/materials', { method: 'POST', body });
      await refresh();
      notify('자료를 등록했어요.');
      onClose();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="자료 올리기" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <label>자료 제목<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="예: 중간고사 시험범위" required autoFocus /></label>
        <div className="form-row">
          <label>과목<select value={subjectId} onChange={(event) => { setSubjectId(event.target.value); setTeacherId(''); }} required>{subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select></label>
          <label>선생님<select value={teacherId} onChange={(event) => setTeacherId(event.target.value)}><option value="">선택 안 함</option>{eligibleTeachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name}T</option>)}</select></label>
        </div>
        <label>자료 유형<select value={kind} onChange={(event) => setKind(event.target.value)}>{['필기', '학습지', '시험범위', '기타'].map((type) => <option key={type}>{type}</option>)}</select></label>
        <label>설명 또는 시험범위<textarea rows={4} value={note} onChange={(event) => setNote(event.target.value)} maxLength={4000} placeholder="파일 없이 글만 등록해도 돼요." /></label>
        <label>사진 · PDF<input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" multiple onChange={(event) => setFiles(Array.from(event.target.files))} /><span className="field-help">파일당 최대 20MB, 한 번에 최대 24개</span></label>
        {files.length > 0 && <p className="selected-files">{files.length}개 파일 선택됨</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions"><button type="button" className="secondary-button" onClick={onClose}>취소</button><button className="primary-button" disabled={busy || !subjects.length}>{busy ? '등록 중…' : '등록하기'}</button></div>
      </form>
    </Modal>
  );
}

function MaterialDetail({ item, admin, onClose, refresh, notify }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [activeImageId, setActiveImageId] = useState(null);
  const [addingFiles, setAddingFiles] = useState(false);
  const [newFiles, setNewFiles] = useState([]);
  const images = item.attachments.filter((file) => file.mime?.startsWith('image/')).sort((a, b) => a.id - b.id);
  const otherFiles = item.attachments.filter((file) => !file.mime?.startsWith('image/'));
  const activeIndex = Math.max(0, images.findIndex((file) => file.id === activeImageId));
  const activeImage = images[activeIndex];

  function moveImage(step) {
    if (images.length < 2) return;
    setActiveImageId(images[(activeIndex + step + images.length) % images.length].id);
  }

  function onGalleryKeyDown(event) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      moveImage(event.key === 'ArrowLeft' ? -1 : 1);
    }
  }

  async function appendFiles(event) {
    event.preventDefault();
    setError('');
    if (!newFiles.length) {
      setError('추가할 사진이나 PDF를 선택해 주세요.');
      return;
    }
    if (newFiles.length > 24) {
      setError('파일은 한 번에 24개까지 올릴 수 있어요.');
      return;
    }
    setBusy(true);
    try {
      const body = new FormData();
      newFiles.forEach((file) => body.append('files', file));
      await api(`/materials/${item.id}/attachments`, { method: 'POST', body });
      const fresh = await refresh();
      const updated = fresh.materials.find((material) => material.id === item.id);
      const existingIds = new Set(item.attachments.map((file) => file.id));
      const firstNewImage = updated?.attachments.find((file) => !existingIds.has(file.id) && file.mime?.startsWith('image/'));
      if (firstNewImage) setActiveImageId(firstNewImage.id);
      setAddingFiles(false);
      setNewFiles([]);
      notify('파일을 추가했어요.');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api(`/materials/${item.id}`, { method: 'DELETE' });
      await refresh();
      notify('자료를 삭제했어요.');
      onClose();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }
  return (
    <Modal title={item.title} onClose={onClose} wide>
      <div className="detail-meta"><span>{item.subject_name}</span>{item.teacher_name && <span>{item.teacher_name}T</span>}<span>{item.kind}</span></div>
      {item.note && <p className="detail-note">{item.note}</p>}
      {images.length > 0 && <section className="image-gallery" aria-label={`${item.title} 사진 ${images.length}장`} onKeyDown={onGalleryKeyDown}>
        <div className="gallery-main">
          <img src={`/api/files/${activeImage.id}`} alt={`${item.title} 사진 ${activeIndex + 1}: ${activeImage.filename}`} />
        </div>
        <div className="gallery-toolbar">
          <div className="gallery-position" aria-live="polite">사진 {activeIndex + 1} / {images.length}</div>
          <div className="gallery-actions">
            <button type="button" className="secondary-button gallery-nav" onClick={() => moveImage(-1)} disabled={images.length < 2} aria-label="이전 사진">이전</button>
            <button type="button" className="secondary-button gallery-nav" onClick={() => moveImage(1)} disabled={images.length < 2} aria-label="다음 사진">다음</button>
            <a className="secondary-button gallery-link" href={`/api/files/${activeImage.id}`} target="_blank" rel="noreferrer">원본 열기</a>
            <a className="icon-button" href={`/api/files/${activeImage.id}?download=1`} download={activeImage.filename} aria-label={`${activeImage.filename} 다운로드`}><Icon name="download" size={18} /></a>
          </div>
        </div>
        <div className="gallery-thumbnails" aria-label="사진 선택">{images.map((file, index) => <button type="button" className={`gallery-thumb ${index === activeIndex ? 'active' : ''}`} key={file.id} onClick={() => setActiveImageId(file.id)} aria-label={`사진 ${index + 1} 보기: ${file.filename}`} aria-current={index === activeIndex ? 'true' : undefined} title={`${index + 1}. ${file.filename}`}>
          <img src={`/api/files/${file.id}`} alt="" loading="lazy" />
          <span>{index + 1}</span>
        </button>)}</div>
        <p className="gallery-hint">사진을 선택하거나 ← → 키로 이동할 수 있어요.</p>
      </section>}
      {otherFiles.length > 0 && <div className="attachment-list">{otherFiles.map((file) => <div className="attachment" key={file.id}>
        <div className="attachment-name"><Icon name="file" size={20} /><span>{file.filename}</span></div>
        <a className="secondary-button" href={`/api/files/${file.id}`} target="_blank" rel="noreferrer">열기 <Icon name="chevronRight" size={15} /></a>
        <a className="icon-button" href={`/api/files/${file.id}?download=1`} download={file.filename} aria-label={`${file.filename} 다운로드`}><Icon name="download" size={18} /></a>
      </div>)}</div>}
      {admin && <>
        {addingFiles && <form className="append-files-form form-stack" onSubmit={appendFiles}>
          <label>이 자료에 파일 추가<input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" multiple onChange={(event) => setNewFiles(Array.from(event.target.files))} /><span className="field-help">기존 파일은 그대로 두고 선택한 파일만 추가해요. 파일당 최대 20MB, 한 번에 최대 24개</span></label>
          {newFiles.length > 0 && <p className="selected-files">{newFiles.length}개 파일 선택됨</p>}
          <div className="form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => { setAddingFiles(false); setNewFiles([]); setError(''); }}>취소</button><button className="primary-button" disabled={busy || !newFiles.length}>{busy ? '추가 중…' : '파일 추가'}</button></div>
        </form>}
        <div className="detail-admin">{!addingFiles && <button type="button" className="secondary-button add-files-button" onClick={() => { setAddingFiles(true); setConfirmDelete(false); setError(''); }}><Icon name="plus" size={17} />파일 추가</button>}{!confirmDelete ? <button type="button" className="danger-text-button" onClick={() => setConfirmDelete(true)}>자료 삭제</button> : <div className="delete-confirm"><span>이 자료와 파일을 삭제할까요?</span><button type="button" className="secondary-button" onClick={() => setConfirmDelete(false)}>취소</button><button type="button" className="danger-button" disabled={busy} onClick={remove}>삭제</button></div>}</div>
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </Modal>
  );
}

export default function Materials({ data, refresh, notify }) {
  const [subjectId, setSubjectId] = useState('all');
  const [teacherId, setTeacherId] = useState('all');
  const [query, setQuery] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const selected = data.materials.find((item) => item.id === selectedId);
  const teachers = subjectId === 'all' ? [] : data.teachers.filter((teacher) => teacher.subject_id === Number(subjectId));
  const visible = useMemo(() => data.materials.filter((item) => {
    if (subjectId !== 'all' && item.subject_id !== Number(subjectId)) return false;
    if (teacherId !== 'all' && item.teacher_id !== Number(teacherId)) return false;
    const search = query.trim().toLocaleLowerCase('ko');
    if (!search) return true;
    return [item.title, item.note, item.subject_name, item.teacher_name, item.kind].some((value) => (value || '').toLocaleLowerCase('ko').includes(search));
  }), [data.materials, query, subjectId, teacherId]);
  const hasAny = data.materials.length > 0;
  return (
    <section className="materials-page">
      <div className="page-heading-row">
        <h1>자료실</h1>
        <label className="search-box"><Icon name="search" size={22} /><input aria-label="자료 검색" placeholder="자료 검색" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      </div>
      <div className="filter-toolbar">
        <div className="filter-scroll" aria-label="과목 선택">
          <button className={`filter-button ${subjectId === 'all' ? 'selected' : ''}`} onClick={() => { setSubjectId('all'); setTeacherId('all'); }}>전체</button>
          {data.subjects.map((subject) => <button key={subject.id} className={`filter-button ${subjectId === subject.id ? 'selected' : ''}`} onClick={() => { setSubjectId(subject.id); setTeacherId('all'); }}>{subject.name}</button>)}
        </div>
        {data.admin && <button className="primary-button upload-button" onClick={() => setUploadOpen(true)}><Icon name="plus" size={18} />자료 올리기</button>}
      </div>
      {subjectId !== 'all' && <div className="teacher-filters" aria-label="선생님 선택"><button className={teacherId === 'all' ? 'active' : ''} onClick={() => setTeacherId('all')}>전체 선생님</button>{teachers.map((teacher) => <button key={teacher.id} className={teacherId === teacher.id ? 'active' : ''} onClick={() => setTeacherId(teacher.id)}>{teacher.name}T</button>)}</div>}
      {visible.length ? <div className="material-list">{visible.map((item) => <button className="material-row" key={item.id} onClick={() => setSelectedId(item.id)}>
        <span className="material-icon"><Icon name="file" size={24} /></span>
        <span className="material-primary"><strong>{item.title}</strong><small>{item.note || (item.attachments.length ? item.attachments.map((file) => file.filename).join(' · ') : '')}</small></span>
        <span className="material-kind">{item.kind}</span>
        <span className="material-subject">{item.subject_name}{item.teacher_name ? ` · ${item.teacher_name}T` : ''}</span>
        <Icon name="chevronRight" size={18} />
      </button>)}</div> : <div className="empty-materials"><Icon name="file" size={72} /><h2>{hasAny ? '찾는 자료가 없어요' : '아직 등록된 자료가 없어요'}</h2><p>{hasAny ? '과목이나 검색어를 바꿔 보세요.' : '관리자가 자료를 올리면 과목별로 여기에서 볼 수 있어요.'}</p></div>}
      {uploadOpen && <MaterialForm subjects={data.subjects} teachers={data.teachers} refresh={refresh} notify={notify} onClose={() => setUploadOpen(false)} />}
      {selected && <MaterialDetail item={selected} admin={data.admin} refresh={refresh} notify={notify} onClose={() => setSelectedId(null)} />}
    </section>
  );
}
