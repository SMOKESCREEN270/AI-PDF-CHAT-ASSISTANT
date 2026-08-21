import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Brain,
  Check,
  CheckSquare,
  CircleHelp,
  Clock,
  FileText,
  LayoutDashboard,
  LockKeyhole,
  MessageSquare,
  Plus,
  Settings as SettingsIcon,
  Sparkles,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { Link, Route, Switch, useLocation } from 'wouter';
import {
  client,
  type Citation,
  type ChatMessage,
  type ChatResponse,
  type ChatSessionSummary,
  type ComparisonResponse,
  type Document,
  type DueFlashcard,
  type FlashcardItem,
  type QuestionnaireItem,
  type QuizItem,
  type StudySetSummary,
} from '@/api/client';
import { useAuth } from '@/context/AuthContext';
import { ErrorBoundary } from '@/components/error-boundary';
import { Document as PdfDocument, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

type WorkspaceContextValue = {
  documents: Document[];
  refreshDocuments: () => Promise<void>;
  selectedId: string;
  setSelectedId: (id: string) => void;
  openUpload: () => void;
  notify: (message: string) => void;
  chatSessions: ChatSessionSummary[];
  refreshChatSessions: () => Promise<void>;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
};

import { createContext, useContext } from 'react';
const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('Workspace context missing');
  return context;
}

function displayName(doc: Document) {
  const title = doc.doc_metadata.title;
  return typeof title === 'string' && title.trim() ? title : doc.filename.replace(/\.pdf$/i, '');
}
function apiError(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

function Brand() {
  return <Link href="/" className="brand"><span className="brand-mark"><BookOpen size={18} /></span><span><span className="brand-name">PDF<br />Assistant</span><span className="brand-sub">Academic Research</span></span></Link>;
}

const navigation = [
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/history', label: 'History', icon: Clock },
  { href: '/study-tools', label: 'Study Tools', icon: BookOpen },
  { href: '/comparisons', label: 'Comparisons', icon: ArrowRight },
  { href: '/library', label: 'Library', icon: FileText },
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
];

function Shell({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const { setActiveSessionId } = useWorkspace();
  const { user, logout } = useAuth();

  function startNewChat() {
    setActiveSessionId(null);
    setLocation('/chat');
  }
  function isActive(href: string) {
    if (href === '/chat') return location === '/chat' || location === '/';
    return location === href;
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <Brand />
      <button className="upload-button" onClick={startNewChat}><Plus size={15} /> New chat</button>
      <nav className="side-nav">{navigation.map(({ href, label, icon: Icon }) => <Link key={href} href={href} className={`nav-link ${isActive(href) ? 'active' : ''}`}><Icon size={18} /><span className="nav-label">{label}</span></Link>)}</nav>
      <div className="sidebar-bottom">
        <Link href="/settings" className={`nav-link ${location === '/settings' ? 'active' : ''}`}><SettingsIcon size={18} /><span className="nav-label">Settings</span></Link>
        <div className="profile-mini"><span className="avatar">{(user?.email?.[0] || 'R').toUpperCase()}</span><span><b>{user?.full_name || user?.email || 'Researcher'}</b></span></div>
        <button className="outline-button" onClick={logout}>Sign out</button>
      </div>
    </aside>
    <main className="main-area">
      <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>
    </main>
  </div>;
}

function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [chatSessions, setChatSessions] = useState<ChatSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const { user } = useAuth();

  const refreshDocuments = useCallback(async () => {
    if (!user) return;
    const next = await client.listDocuments();
    setDocuments(next);
    setSelectedId((current) => current || next[0]?.id || '');
  }, [user]);

  const refreshChatSessions = useCallback(async () => {
    if (!user) return;
    try {
      const next = await client.listSessions();
      setChatSessions(next);
    } catch {
      // A failed sidebar refresh shouldn't disrupt the rest of the app.
    }
  }, [user]);

  useEffect(() => { void refreshDocuments().catch((error) => setToast(apiError(error))); }, [refreshDocuments]);
  useEffect(() => { void refreshChatSessions(); }, [refreshChatSessions]);
  useEffect(() => {
    if (!documents.some((doc) => doc.status === 'processing')) return;
    const timer = window.setInterval(() => { void refreshDocuments(); }, 2500);
    return () => window.clearInterval(timer);
  }, [documents, refreshDocuments]);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2800);
  }, []);
  const value = useMemo(() => ({
    documents, refreshDocuments, selectedId, setSelectedId, openUpload: () => setUploadOpen(true), notify,
    chatSessions, refreshChatSessions, activeSessionId, setActiveSessionId,
  }), [documents, refreshDocuments, selectedId, notify, chatSessions, refreshChatSessions, activeSessionId]);
  return <WorkspaceContext.Provider value={value}>{children}{uploadOpen && <UploadModal onClose={() => setUploadOpen(false)} />}{toast && <div className="toast-note">{toast}</div>}</WorkspaceContext.Provider>;
}

function UploadModal({ onClose }: { onClose: () => void }) {
  const { refreshDocuments, setSelectedId, notify } = useWorkspace();
  const [files, setFiles] = useState<File[]>([]);
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem('pdf-assistant-openrouter-key') || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    if (!files.length) return;
    setBusy(true); setError('');
    try {
      const uploaded = await client.uploadDocuments(files, apiKey || undefined);
      sessionStorage.setItem('pdf-assistant-openrouter-key', apiKey);
      await refreshDocuments();
      if (uploaded[0]) setSelectedId(uploaded[0].id);
      notify(`${uploaded.length} document${uploaded.length === 1 ? '' : 's'} uploaded`);
      onClose();
    } catch (cause) { setError(apiError(cause)); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true">
    <div className="section-title"><div><span className="eyebrow">Library intake</span><h2>Add papers</h2></div><button className="icon-button" onClick={onClose}><X size={19} /></button></div>
    <label className="dropzone"><Upload size={25} /><strong>{files.length ? `${files.length} PDF${files.length === 1 ? '' : 's'} selected` : 'Choose PDF files'}</strong><span className="muted small">The backend will process and index them for grounded answers.</span><input type="file" accept=".pdf,application/pdf" multiple hidden onChange={(event) => setFiles(Array.from(event.target.files || []))} /></label>
    <label className="label">Optional OpenRouter API key<input className="field" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Used for this request only" /></label>
    {error && <p className="error-message">{error}</p>}
    <div className="action-row" style={{ justifyContent: 'flex-end', marginTop: 20 }}><button className="outline-button" onClick={onClose}>Cancel</button><button className="gold-button" disabled={!files.length || busy} onClick={() => void submit()}>{busy ? 'Processing…' : 'Upload and analyze'} <ArrowRight size={15} /></button></div>
  </div></div>;
}

function Status({ doc }: { doc: Document }) {
  const status = doc.status === 'ready' ? 'Ready' : doc.status === 'failed' ? 'Failed' : 'Processing';
  return <span className={`status-pill status-${doc.status}`}><span>●</span> {status}</span>;
}

function CitationCard({ citation, onOpen }: { citation: Citation; onOpen?: (citation: Citation) => void }) {
  return <button type="button" className="citation citation-card" onClick={() => onOpen?.(citation)} aria-label={`Open ${citation.filename} at page ${citation.page}`}>
    <div><strong>{citation.filename}</strong><span className="small muted">Page {citation.page} · lines {citation.line_start ?? '—'}–{citation.line_end ?? '—'}</span></div>
    <p className="serif" style={{ margin: '8px 0 0' }}>{/* Safe by default: React escapes citation snippets as text. */}{citation.snippet}</p>
    {onOpen && <span className="citation-open-hint">Open source in viewer <ArrowRight size={13} /></span>}
  </button>;
}

function PdfViewer({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  const [numPages, setNumPages] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [pageWidth, setPageWidth] = useState(640);
  const [fallbackHighlight, setFallbackHighlight] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const file = useMemo(() => ({
    url: `/api/documents/${encodeURIComponent(citation.document_id)}/file`,
    withCredentials: true,
  }), [citation.document_id]);

  useEffect(() => {
    const updateWidth = () => setPageWidth(Math.max(280, Math.min(680, window.innerWidth - 430)));
    updateWidth();
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  const highlightTextLayer = useCallback(() => {
    const root = pageRef.current;
    if (!root) return;
    const spans = Array.from(root.querySelectorAll<HTMLElement>('.react-pdf__Page__textContent span'));
    spans.forEach((span) => span.classList.remove('citation-text-highlight'));
    const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
    // Citation text is read through textContent and only toggles CSS classes; no HTML is inserted.
    const snippet = normalize(citation.snippet || '');
    const terms = snippet.split(' ').filter((term) => term.length > 3).slice(0, 14);
    let matched = false;
    if (snippet && terms.length) {
      spans.forEach((span) => {
        const text = normalize(span.textContent || '');
        if (text.length > 2 && (snippet.includes(text) || text.includes(terms.slice(0, 5).join(' ')) || terms.some((term) => text.includes(term)))) {
          span.classList.add('citation-text-highlight');
          matched = true;
        }
      });
    }
    // Exact line-level positions are not exposed consistently by PDF.js. When the
    // snippet cannot be matched, the complete cited page is highlighted instead.
    setFallbackHighlight(!matched);
    root.classList.toggle('citation-page-fallback', !matched);
  }, [citation.snippet]);

   return <aside className="pdf-viewer-panel" aria-label="Source document viewer">
    <div className="pdf-viewer-header">
      <div><span className="eyebrow">Source viewer</span><h2>{citation.filename}</h2><p className="small muted">Page {citation.page} · lines {citation.line_start ?? '—'}–{citation.line_end ?? '—'}</p></div>
      <button className="icon-button" onClick={onClose} aria-label="Close source viewer"><X size={19} /></button>
    </div>
    <div className="pdf-viewer-note">{fallbackHighlight ? 'Cited page highlighted' : 'Cited passage highlighted'} <span>PDF.js text layer</span></div>
    <div className="pdf-page-scroll">
      {loadError ? <div className="empty-state"><FileText size={25} /><p>{loadError}</p></div> : <PdfDocument
        file={file}
        loading={<div className="pdf-loading">Loading source document…</div>}
        onLoadSuccess={({ numPages: pages }) => { setNumPages(pages); setLoadError(''); }}
        onLoadError={() => setLoadError('Unable to load this source document.')}
      >
        <div ref={pageRef} className="pdf-page-wrap">
          <Page
            pageNumber={Math.max(1, citation.page)}
            width={pageWidth}
            renderTextLayer
            renderAnnotationLayer
            onRenderTextLayerSuccess={() => window.requestAnimationFrame(highlightTextLayer)}
          />
        </div>
      </PdfDocument>}
    </div>
    <div className="pdf-viewer-footer"><span>{numPages ? `Page ${citation.page} of ${numPages}` : 'Preparing page…'}</span><span className="small muted">Scroll to inspect the highlighted source</span></div>
  </aside>;
}

const EXPORT_FORMATS: Array<{ value: string; label: string }> = [
  { value: 'pdf', label: 'PDF' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'docx', label: 'Word' },
  { value: 'json', label: 'JSON' },
];

function ExportControl({ kind, refId, data, label = 'Export' }: { kind: string; refId?: string | null; data?: Record<string, unknown>; label?: string }) {
  const { notify } = useWorkspace();
  const [format, setFormat] = useState('pdf');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function download() {
    if (!refId || busy) return;
    setBusy(true);
    setError('');
    try {
      const blob = await client.exportArtifact({ kind, ref_id: refId, format, data });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${kind}-export.${format === 'markdown' ? 'md' : format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      notify(`${kind[0].toUpperCase()}${kind.slice(1)} export downloaded`);
    } catch (cause) {
      setError(apiError(cause));
    } finally {
      setBusy(false);
    }
  }
  return <div className="export-bar" role="group" aria-label={`${label} options`}>
    <div className="format-pills">
      {EXPORT_FORMATS.map((option) => <button key={option.value} type="button" className={`format-pill ${format === option.value ? 'active' : ''}`} disabled={!refId || busy} aria-pressed={format === option.value} onClick={() => setFormat(option.value)}>{option.label}</button>)}
    </div>
    <button className="export-go-button" disabled={!refId || busy} onClick={() => void download()}>{busy && <span className="spinner spinner-sm" aria-hidden="true" />}{busy ? 'Preparing…' : label}{!busy && <ArrowRight size={14} />}</button>
    {error && <span className="error-message small">{error}</span>}
  </div>;
}

type ExportOption = { kind: string; refId?: string | null; label: string };

function CombinedExportControl({ options }: { options: ExportOption[] }) {
  const { notify } = useWorkspace();
  const [selectedKind, setSelectedKind] = useState(options[0]?.kind ?? '');
  const [format, setFormat] = useState('pdf');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = options.find((option) => option.kind === selectedKind) ?? options[0];
  const refId = active?.refId;

  async function download() {
    if (!active || !refId || busy) return;
    setBusy(true);
    setError('');
    try {
      const blob = await client.exportArtifact({ kind: active.kind, ref_id: refId, format });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${active.kind}-export.${format === 'markdown' ? 'md' : format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      notify(`${active.label} downloaded`);
    } catch (cause) {
      setError(apiError(cause));
    } finally {
      setBusy(false);
    }
  }

  return <div className="export-bar" role="group" aria-label="Export options">
    {options.length > 1 && <select className="export-bar-kind select" aria-label="What to export" value={selectedKind} onChange={(event) => setSelectedKind(event.target.value)}>
      {options.map((option) => <option key={option.kind} value={option.kind}>{option.label}</option>)}
    </select>}
    <div className="format-pills">
      {EXPORT_FORMATS.map((option) => <button key={option.value} type="button" className={`format-pill ${format === option.value ? 'active' : ''}`} disabled={!refId || busy} aria-pressed={format === option.value} onClick={() => setFormat(option.value)}>{option.label}</button>)}
    </div>
    <button className="export-go-button" disabled={!refId || busy} onClick={() => void download()}>{busy && <span className="spinner spinner-sm" aria-hidden="true" />}{busy ? 'Preparing…' : 'Export'}{!busy && <ArrowRight size={14} />}</button>
    {error && <span className="error-message small">{error}</span>}
  </div>;
}

function ChatDocumentPicker({ chosen, onToggle }: { chosen: string[]; onToggle: (id: string) => void }) {
  const { documents, openUpload, refreshDocuments, notify } = useWorkspace();
  async function remove(id: string) {
    try {
      await client.deleteDocument(id);
      await refreshDocuments();
      notify('Document removed');
    } catch (cause) {
      notify(apiError(cause));
    }
  }
  return <aside className="chat-context">
    <div className="section-title" style={{ marginBottom: 0 }}>
      <span className="eyebrow">Documents</span>
      <button className="icon-button" onClick={openUpload} aria-label="Upload a PDF" title="Upload a PDF"><Upload size={15} /></button>
    </div>
    <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
      {documents.length === 0 && <p className="small muted">No documents yet — upload a PDF to get started.</p>}
      {documents.map((doc) => <div key={doc.id} className="chat-doc-row">
        {doc.status === 'ready'
          ? <label className={`option ${chosen.includes(doc.id) ? 'selected' : ''}`}>
              <input type="checkbox" checked={chosen.includes(doc.id)} onChange={() => onToggle(doc.id)} /> <span className="small">{displayName(doc)}</span>
            </label>
          : <div className="option option-disabled">
              <span className="small">{displayName(doc)}</span>
              <Status doc={doc} />
            </div>}
        <button className="icon-button" onClick={() => void remove(doc.id)} aria-label={`Delete ${displayName(doc)}`} title="Delete document"><Trash2 size={14} /></button>
      </div>)}
    </div>
  </aside>;
}

function Chat() {
  const { documents, activeSessionId, setActiveSessionId, refreshChatSessions } = useWorkspace();
  const [chosen, setChosen] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [lastResponse, setLastResponse] = useState<ChatResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingSession, setLoadingSession] = useState(Boolean(activeSessionId));
  const [error, setError] = useState('');
  const [activeCitation, setActiveCitation] = useState<Citation | null>(null);

  // Default to the most recently uploaded ready document for a brand-new chat.
  useEffect(() => {
    if (activeSessionId || chosen.length) return;
    const firstReady = documents.find((doc) => doc.status === 'ready');
    if (firstReady) setChosen([firstReady.id]);
  }, [activeSessionId, chosen.length, documents]);

  // Load a resumed chat's history and restore which documents it was scoped
  // to. This component is remounted (see ChatRoute's `key`) every time
  // activeSessionId changes, so there is no leftover state from a previous
  // conversation to reconcile here - just an initial fetch for this one id.
  useEffect(() => {
    if (!activeSessionId) return;
    let active = true;
    setLoadingSession(true);
    setError('');
    void client.getSessionMessages(activeSessionId)
      .then((history) => {
        if (!active) return;
        setMessages(history);
        setSessionId(activeSessionId);
        return client.listSessions().then((sessions) => {
          if (!active) return;
          const match = sessions.find((s) => s.id === activeSessionId);
          if (match) setChosen(match.document_ids ?? []);
        });
      })
      .catch((cause) => { if (active) setError(apiError(cause)); })
      .finally(() => { if (active) setLoadingSession(false); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  async function send() {
    if (!input.trim() || !chosen.length || busy) return;
    const question = input.trim();
    setInput('');
    setBusy(true);
    setError('');
    setMessages((current) => [...current, { role: 'user', content: question }]);
    try {
      const storedKey = sessionStorage.getItem('pdf-assistant-openrouter-key');
      const isNewSession = !sessionId;
      const response = await client.chat({
        document_ids: chosen,
        message: question,
        session_id: sessionId,
        user_api_key: storedKey ? { provider: 'openrouter', api_key: storedKey } : null,
      });
      setSessionId(response.session_id);
      setActiveSessionId(response.session_id);
      setLastResponse(response);
      setMessages((current) => [...current, {
        role: 'assistant',
        content: response.answer,
        citations: response.citations,
        summary: response.summary,
        confidence_score: response.confidence_score,
        hallucination_flag: response.hallucination_flag,
        highlighted_sections: response.highlighted_sections,
      }]);
      if (isNewSession) void refreshChatSessions();
    } catch (cause) {
      setError(apiError(cause));
    } finally {
      setBusy(false);
    }
  }

  const exportOptions: ExportOption[] = [
    { kind: 'chat', refId: sessionId, label: 'Chat transcript' },
    { kind: 'summary', refId: lastResponse?.message_id, label: 'Latest answer summary' },
  ];

  return (
    <div className="page">
      <div className="page-heading">
        <div><span className="eyebrow">Grounded conversation</span><h1>Ask your library.</h1><p>Every response is anchored to the documents you select, with page and line citations.</p></div>
        <CombinedExportControl options={exportOptions} />
      </div>
      <div className={`card chat-layout ${activeCitation ? 'has-pdf-viewer' : ''}`}>
        <ChatDocumentPicker chosen={chosen} onToggle={(id) => setChosen((current) => current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id])} />
        <section className="chat-main">
          <div className="chat-messages">
            {loadingSession && <div className="empty-state"><MessageSquare size={25} /><p>Loading conversation…</p></div>}
            {!loadingSession && !messages.length && <div className="empty-state"><MessageSquare size={25} /><p>Select a document and ask your first question.</p></div>}
            {!loadingSession && messages.map((message, index) => <div key={`${message.created_at || index}-${index}`} className={`message ${message.role === 'user' ? 'user' : ''}`}>
              <div className="small eyebrow" style={{ marginBottom: 8 }}>{message.role === 'user' ? 'You' : 'PDF Assistant'}</div>
              <div className="summary-copy" style={{ fontSize: 17 }}>
                {/* Safe by default: React escapes chat answers and user messages as text. */}
                {message.content}
              </div>
              {message.role === 'assistant' && message.confidence_score !== undefined && <div className="status-pill" style={{ marginTop: 12 }}>Confidence {Math.round(message.confidence_score * 100)}%</div>}
              {message.role === 'assistant' && message.hallucination_flag && <div className="warning-message" style={{ marginTop: 12 }}>Review warning: the answer has lower source confidence. Check the citations carefully.</div>}
              {message.role === 'assistant' && message.summary?.key_insights && <div className="card card-pad" style={{ marginTop: 14 }}>
                <span className="eyebrow">Answer summary</span>
                <p className="serif">{/* Safe by default: React escapes the summary text. */}{message.summary.short_summary}</p>
                <ul>{message.summary.key_insights.map((insight) => <li key={insight}>{/* Safe by default: React escapes each summary insight. */}{insight}</li>)}</ul>
                <p className="serif"><strong>Conclusion:</strong> {/* Safe by default: React escapes the summary conclusion. */}{message.summary.conclusion}</p>
              </div>}
              {message.citations?.map((citation, citationIndex) => <CitationCard key={`${citation.document_id}-${citation.page}-${citationIndex}`} citation={citation} onOpen={setActiveCitation} />)}
              {message.highlighted_sections?.length ? <div style={{ marginTop: 12 }}><span className="eyebrow">Highlighted source sections</span>{message.highlighted_sections.map((citation, citationIndex) => <CitationCard key={`highlight-${citation.document_id}-${citation.page}-${citationIndex}`} citation={citation} onOpen={setActiveCitation} />)}</div> : null}
            </div>)}
          </div>
          {error && <p className="error-message" style={{ margin: '0 24px 10px' }}>{error}</p>}
          <div className="chat-composer">
            <input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void send(); }} placeholder={chosen.length ? 'Ask a question about these papers…' : 'Select a ready document first'} disabled={!chosen.length || busy} />
            <button className="gold-button" onClick={() => void send()} disabled={!chosen.length || busy}>{busy ? 'Thinking…' : 'Send'} <ArrowRight size={15} /></button>
          </div>
        </section>
        {activeCitation && <PdfViewer citation={activeCitation} onClose={() => setActiveCitation(null)} />}
      </div>
    </div>
  );
}

function Comparisons() {
  const { documents, notify } = useWorkspace();
  const [chosen, setChosen] = useState<string[]>([]);
  const [scenario, setScenario] = useState('');
  const [result, setResult] = useState<ComparisonResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function compare() {
    if (chosen.length < 2) { setError('Select at least two documents to compare.'); return; }
    setBusy(true); setError('');
    try {
      const storedKey = sessionStorage.getItem('pdf-assistant-openrouter-key');
      setResult(await client.compareDocuments({
        document_ids: chosen,
        scenario_context: scenario || undefined,
        user_api_key: storedKey ? { provider: 'openrouter', api_key: storedKey } : null,
      }));
      notify('Synthesis refreshed');
    } catch (cause) { setError(apiError(cause)); } finally { setBusy(false); }
  }
  return <div className="page">
    <div className="page-heading">
      <div><span className="eyebrow">Literature mapping</span><h1>Compare the field.</h1><p>Ask the AI to compare real excerpts from your selected documents.</p></div>
      <div className="action-row"><button className="gold-button" disabled={busy} onClick={() => void compare()}>{busy ? <span className="spinner spinner-sm" aria-hidden="true" /> : <Sparkles size={15} />} {busy ? 'Synthesizing…' : 'Synthesize selection'}</button>{result && <ExportControl kind="comparison" refId="comparison-result" data={result as unknown as Record<string, unknown>} label="Export comparison" />}</div>
    </div>
    <div className="card card-pad" style={{ marginBottom: 28 }}>
      <div className="section-title"><h2>Select papers</h2><span className="status-pill">{chosen.length} selected</span></div>
      <div className="grid grid-2">{documents.filter((doc) => doc.status === 'ready').map((doc) => <label key={doc.id} className={`option ${chosen.includes(doc.id) ? 'selected' : ''}`}><input type="checkbox" checked={chosen.includes(doc.id)} onChange={() => setChosen((current) => current.includes(doc.id) ? current.filter((id) => id !== doc.id) : [...current, doc.id])} /> <strong>{displayName(doc)}</strong></label>)}</div>
      <label className="label" style={{ marginTop: 20 }}>Scenario context<input className="field" value={scenario} onChange={(event) => setScenario(event.target.value)} placeholder="For a beginner ML student, a thesis review, or your own context" /></label>
      {error && <p className="error-message">{error}</p>}
      {busy && <div className="generating-panel"><span className="spinner" aria-hidden="true" /><div className="generating-copy"><strong>Synthesizing your comparison…</strong><span>This calls the AI model across every selected document, so it can take a minute or two. Feel free to wait here.</span></div></div>}
    </div>
     {result && <><section className="card card-pad accent-card"><div className="section-title"><h2>AI synthesis</h2><Sparkles size={20} color="var(--gold)" /></div><div className="table-wrap"><table className="matrix"><thead><tr><th>Dimension</th>{result.table.map((row) => <th key={row.document}>{/* Safe by default: React escapes backend-generated document labels. */}{row.document}</th>)}</tr></thead><tbody>{result.dimensions.map((dimension) => <tr key={dimension}><td>{/* Safe by default: React escapes backend-generated dimensions. */}{dimension}</td>{result.table.map((row) => <td key={`${row.document}-${dimension}`} className="serif">{/* Safe by default: React escapes backend-generated comparison values. */}{row.values[dimension] || '—'}</td>)}</tr>)}</tbody></table></div></section><section style={{ marginTop: 28 }}><h2>Recommendations</h2><div className="grid grid-2" style={{ marginTop: 16 }}>{result.recommendations.map((recommendation) => <article className="card card-pad" key={`${recommendation.scenario}-${recommendation.best_document}`}><span className="eyebrow">{/* Safe by default: React escapes backend-generated recommendation scenarios. */}{recommendation.scenario}</span><h3 style={{ marginTop: 8 }}>{/* Safe by default: React escapes backend-generated document names. */}{recommendation.best_document}</h3><p className="serif">{/* Safe by default: React escapes backend-generated recommendation text. */}{recommendation.reason}</p></article>)}</div></section></>}
  </div>;
}

const DIFFICULTY_OPTIONS = [
  { value: 'mixed', label: 'Mixed' },
  { value: 'easy', label: 'Easy' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'advanced', label: 'Advanced' },
];

const QUESTIONNAIRE_CATEGORIES = [
  { key: 'knowledge', label: 'Knowledge-based', desc: 'Define, Identify, List, State' },
  { key: 'understanding', label: 'Understanding-based', desc: 'Explain, Describe, Summarize' },
  { key: 'application', label: 'Application-based', desc: 'Apply, Example, Scenario, Case Study' },
  { key: 'analysis', label: 'Analysis-based', desc: 'Analyze, Compare, Differentiate, Cause & Effect' },
  { key: 'evaluation', label: 'Evaluation-based', desc: 'Evaluate, Critically Discuss, Justify, your opinion' },
  { key: 'creation', label: 'Creation / problem-solving', desc: 'Suggest, Recommend, Design, Propose a solution' },
];

function GeneratingPanel({ label }: { label: string }) {
  return <div className="generating-panel">
    <span className="spinner" aria-hidden="true" />
    <div className="generating-copy">
      <strong>{label}</strong>
      <span>The AI is reading through your document and writing these from scratch, so this can take a minute or two. Feel free to stay on this page.</span>
    </div>
  </div>;
}

function FlowProgress({ index, total }: { index: number; total: number }) {
  return <div className="flow-progress">
    <span className="small muted">Question {index + 1} of {total}</span>
    <div className="flow-dots">
      {Array.from({ length: total }, (_, i) => <span key={i} className={`flow-dot ${i === index ? 'current' : i < index ? 'done' : ''}`} />)}
    </div>
  </div>;
}

function StudyTools() {
  const { documents } = useWorkspace();
  const [tab, setTab] = useState<'quiz' | 'flashcards' | 'questionnaire'>('quiz');
  const [view, setView] = useState<'generator' | 'due'>('generator');
  const [documentId, setDocumentId] = useState('');
  const [items, setItems] = useState<Array<QuizItem | FlashcardItem | QuestionnaireItem>>([]);
  const [setId, setSetId] = useState('');
  const [setTitle, setSetTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [flowIndex, setFlowIndex] = useState(0);

  // Quiz state: an option can be picked freely, but once submitted for a
  // given question it's locked in - no more changing your mind on a
  // question you've already answered.
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  // Flashcards: front/back flip, then a one-time Hard/Good/Easy rating.
  const [flipped, setFlipped] = useState<Record<number, boolean>>({});
  const [rated, setRated] = useState<Record<number, boolean>>({});
  // Questionnaire: an optional free-text attempt, then a one-time reveal.
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});

  // Generation config.
  const [numItems, setNumItems] = useState(8);
  const [difficulty, setDifficulty] = useState('mixed');
  const [questionTypes, setQuestionTypes] = useState<string[]>([]);

  const [dueCards, setDueCards] = useState<DueFlashcard[]>([]);
  const [dueBusy, setDueBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);
  const readyDocs = documents.filter((doc) => doc.status === 'ready');

  // Deep-link from the Dashboard page: /study-tools?set=<id> opens a
  // previously generated set straight into its review flow.
  useEffect(() => {
    const requestedSetId = new URLSearchParams(window.location.search).get('set');
    if (!requestedSetId) return;
    let active = true;
    setBusy(true);
    void client.getStudySet(requestedSetId)
      .then((response) => {
        if (!active) return;
        if (response.kind === 'quiz' || response.kind === 'flashcards' || response.kind === 'questionnaire') {
          setTab(response.kind);
        }
        setItems(response.items as Array<QuizItem | FlashcardItem | QuestionnaireItem>);
        setSetId(response.set_id);
        setSetTitle(response.title);
        setFlowIndex(0);
      })
      .catch((cause) => { if (active) setError(apiError(cause)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  function resetFlowState() {
    setAnswers({}); setChecked({}); setFlipped({}); setRated({}); setDrafts({}); setRevealed({});
    setFlowIndex(0);
  }

  function switchTab(key: typeof tab) {
    setView('generator'); setTab(key); setItems([]); setSetId(''); setSetTitle('');
    resetFlowState();
  }

  async function loadDueCards() {
    setDueBusy(true);
    try {
      setDueCards(await client.getDueFlashcards());
    } catch (cause) {
      setError(apiError(cause));
    } finally {
      setDueBusy(false);
    }
  }

  async function reviewCard(flashcardId: string, quality: number) {
    setReviewBusy(flashcardId);
    setError('');
    try {
      await client.reviewFlashcard(flashcardId, quality);
      await loadDueCards();
    } catch (cause) {
      setError(apiError(cause));
    } finally {
      setReviewBusy(null);
    }
  }

  async function generate() {
    if (!documentId) {
      setError('Choose a ready document first.');
      return;
    }
    setBusy(true);
    setError('');
    resetFlowState();
    setSetTitle('');
    try {
      const key = sessionStorage.getItem('pdf-assistant-openrouter-key');
      const auth = key ? { provider: 'openrouter', api_key: key } : null;
      const response = tab === 'quiz'
        ? await client.generateQuiz({ document_id: documentId, num_questions: numItems, difficulty, user_api_key: auth })
        : tab === 'flashcards'
          ? await client.generateFlashcards({ document_id: documentId, num_cards: numItems, difficulty, user_api_key: auth })
          : await client.generateQuestionnaire({ document_id: documentId, num_questions: numItems, difficulty, question_types: questionTypes, user_api_key: auth });
      setItems(response.items);
      setSetId(response.set_id);
    } catch (cause) {
      setError(apiError(cause));
    } finally {
      setBusy(false);
    }
  }

  function toggleQuestionType(key: string) {
    setQuestionTypes((current) => current.includes(key) ? current.filter((k) => k !== key) : [...current, key]);
  }

  const quizItems = items as QuizItem[];
  const flashcardItems = items as FlashcardItem[];
  const questionnaireItems = items as QuestionnaireItem[];
  const total = items.length;
  const atLastItem = flowIndex >= total - 1;

  return <div className="page">
    <div className="page-heading"><div><span className="eyebrow">Active recall studio</span><h1>Study with intention.</h1><p>Generate exercises from a real uploaded document and keep scoring in this session.</p></div><Brain size={26} color="var(--gold)" /></div>
    <div className="tool-tabs">
      {(['quiz', 'flashcards', 'questionnaire'] as const).map((key) => <button key={key} className={`tool-tab ${view === 'generator' && tab === key ? 'active' : ''}`} onClick={() => switchTab(key)}>{key[0].toUpperCase() + key.slice(1)}</button>)}
      <button className={`tool-tab ${view === 'due' ? 'active' : ''}`} onClick={() => { setView('due'); void loadDueCards(); }}>Recall Queue {dueCards.length > 0 && <span className="status-pill">{dueCards.length}</span>}</button>
    </div>
    {view === 'generator' && <div className="card card-pad gen-config" style={{ marginBottom: 24 }}>
      <label className="label">Source document<select className="select" value={documentId} onChange={(event) => setDocumentId(event.target.value)}><option value="">Choose a ready document</option>{readyDocs.map((doc) => <option key={doc.id} value={doc.id}>{displayName(doc)}</option>)}</select></label>
      <div className="gen-config-row">
        <label className="label">Number of {tab === 'flashcards' ? 'cards' : 'questions'}
          <div className="count-control"><input type="range" min={3} max={25} value={numItems} onChange={(event) => setNumItems(Number(event.target.value))} /><span className="count-value">{numItems}</span></div>
        </label>
        <label className="label">Difficulty
          <div className="pill-select">{DIFFICULTY_OPTIONS.map((option) => <button key={option.value} type="button" className={difficulty === option.value ? 'active' : ''} onClick={() => setDifficulty(option.value)}>{option.label}</button>)}</div>
        </label>
      </div>
      {tab === 'questionnaire' && <div>
        <span className="label">Question types <span style={{ textTransform: 'none', fontWeight: 400 }}>(none selected = spread across all)</span></span>
        <div className="category-grid">{QUESTIONNAIRE_CATEGORIES.map((category) => <label key={category.key} className="category-check"><input type="checkbox" checked={questionTypes.includes(category.key)} onChange={() => toggleQuestionType(category.key)} /><span><strong>{category.label}</strong><small>{category.desc}</small></span></label>)}</div>
      </div>}
      <div className="action-row"><button className="gold-button" disabled={busy} onClick={() => void generate()}>{busy && <span className="spinner spinner-sm" aria-hidden="true" />}{busy ? 'Generating…' : 'Generate set'} {!busy && <ArrowRight size={15} />}</button></div>
      {error && <p className="error-message">{error}</p>}
      {busy && <GeneratingPanel label={`Building your ${tab}…`} />}
    </div>}
    {view === 'due' && <section>
      <div className="section-title"><div><span className="eyebrow">Spaced repetition</span><h2>Recall Queue</h2></div><button className="outline-button" disabled={dueBusy} onClick={() => void loadDueCards()}>{dueBusy ? 'Refreshing…' : 'Refresh'}</button></div>
      {error && <p className="error-message">{error}</p>}
      {dueBusy && !dueCards.length ? <div className="empty-state">Loading cards due now…</div> : dueCards.length ? <div className="grid grid-2">{dueCards.map((card) => <article className="card card-pad" key={card.flashcard_id}>
        <span className="eyebrow">Review card</span>
        <h3 style={{ margin: '12px 0' }}>{/* Safe by default: React escapes flashcard front content. */}{card.front}</h3>
        <p className="summary-copy">{/* Safe by default: React escapes flashcard back content. */}{card.back}</p>
        <div className="action-row" style={{ marginTop: 18 }}><button className="outline-button" disabled={reviewBusy === card.flashcard_id} onClick={() => void reviewCard(card.flashcard_id, 2)}>Hard</button><button className="outline-button" disabled={reviewBusy === card.flashcard_id} onClick={() => void reviewCard(card.flashcard_id, 4)}>Good</button><button className="gold-button" disabled={reviewBusy === card.flashcard_id} onClick={() => void reviewCard(card.flashcard_id, 5)}>Easy</button></div>
      </article>)}</div> : <div className="empty-state"><Check size={26} /><h3>Nothing due right now</h3><p>Generate flashcards or check back after your next review interval.</p></div>}
    </section>}
    {setId && total > 0 && <div className="action-row" style={{ margin: '15px 0' }}><p className="small muted">{setTitle || `Set ${setId.slice(0, 8)}`} · {total} generated items</p><ExportControl kind={tab} refId={setId} label={`Export ${tab}`} /></div>}

    {view === 'generator' && tab === 'quiz' && total > 0 && <div className="card card-pad flow-card">
      <FlowProgress index={flowIndex} total={total} />
      {(() => {
        const item = quizItems[flowIndex];
        const index = flowIndex;
        const isChecked = Boolean(checked[index]);
        return <section key={index}>
          <h3 style={{ margin: '0 0 15px' }}>{/* Safe by default: React escapes quiz questions. */}{item.question}</h3>
          <div style={{ display: 'grid', gap: 9 }}>{item.options.map((option, optionIndex) => {
            const isSelected = answers[index] === optionIndex;
            const isCorrectOption = optionIndex === item.correct_index;
            const stateClass = isChecked ? (isCorrectOption ? 'correct' : (isSelected ? 'incorrect' : '')) : (isSelected ? 'selected' : '');
            return <button key={option} className={`option answer-option ${stateClass}`} disabled={isChecked} onClick={() => setAnswers((current) => ({ ...current, [index]: optionIndex }))}>{/* Safe by default: React escapes quiz options. */}{option}{isSelected && <Check size={16} style={{ float: 'right', color: 'var(--gold-deep)' }} />}</button>;
          })}</div>
          {!isChecked
            ? <button className="gold-button" style={{ marginTop: 15 }} disabled={answers[index] === undefined} onClick={() => setChecked((current) => ({ ...current, [index]: true }))}>Submit answer <ArrowRight size={15} /></button>
            : <p className={answers[index] === item.correct_index ? 'success-message' : 'error-message'} style={{ marginTop: 15 }}>{answers[index] === item.correct_index ? 'Correct.' : `Not quite. Correct answer: ${item.options[item.correct_index]}`} {/* Safe by default: React escapes quiz explanations. */}{item.explanation}</p>}
          <div className="flow-nav">
            <button className="outline-button" disabled={flowIndex === 0} onClick={() => setFlowIndex((i) => Math.max(0, i - 1))}><ArrowLeft size={15} /> Previous</button>
            {!atLastItem && <button className="outline-button" disabled={!isChecked} onClick={() => setFlowIndex((i) => Math.min(total - 1, i + 1))}>Next question <ArrowRight size={15} /></button>}
          </div>
        </section>;
      })()}
    </div>}

    {view === 'generator' && tab === 'flashcards' && total > 0 && <div className="card card-pad flow-card">
      <FlowProgress index={flowIndex} total={total} />
      {(() => {
        const item = flashcardItems[flowIndex];
        const index = flowIndex;
        const isFlipped = Boolean(flipped[index]);
        const isRated = Boolean(rated[index]);
        return <article key={index}>
          <button className="flashcard-face" onClick={() => setFlipped((current) => ({ ...current, [index]: !current[index] }))}>
            <span className="eyebrow">{isFlipped ? 'Answer' : 'Prompt'}</span>
            <h3 style={{ marginTop: 18 }}>{/* Safe by default: React escapes flashcard front/back content. */}{isFlipped ? item.back : item.front}</h3>
            <span className="small muted" style={{ display: 'block', marginTop: 18 }}>Click to {isFlipped ? 'show prompt' : 'reveal answer'}</span>
          </button>
          {isFlipped && item.id && <div className="action-row" style={{ marginTop: 18 }}>
            <button className="outline-button" disabled={isRated} onClick={() => { setRated((current) => ({ ...current, [index]: true })); void reviewCard(item.id!, 2); }}>Hard</button>
            <button className="outline-button" disabled={isRated} onClick={() => { setRated((current) => ({ ...current, [index]: true })); void reviewCard(item.id!, 4); }}>Good</button>
            <button className="gold-button" disabled={isRated} onClick={() => { setRated((current) => ({ ...current, [index]: true })); void reviewCard(item.id!, 5); }}>Easy</button>
          </div>}
          {isRated && <p className="success-message" style={{ marginTop: 15 }}>Rating saved - it'll come back around based on how you did.</p>}
          <div className="flow-nav">
            <button className="outline-button" disabled={flowIndex === 0} onClick={() => setFlowIndex((i) => Math.max(0, i - 1))}><ArrowLeft size={15} /> Previous</button>
            {!atLastItem && <button className="outline-button" disabled={!isFlipped} onClick={() => setFlowIndex((i) => Math.min(total - 1, i + 1))}>Next card <ArrowRight size={15} /></button>}
          </div>
        </article>;
      })()}
    </div>}

    {view === 'generator' && tab === 'questionnaire' && total > 0 && <div className="card card-pad flow-card">
      <FlowProgress index={flowIndex} total={total} />
      {(() => {
        const item = questionnaireItems[flowIndex];
        const index = flowIndex;
        const isRevealed = Boolean(revealed[index]);
        return <article key={index}>
          <span className="eyebrow">{item.type}{item.difficulty ? ` · ${item.difficulty}` : ''}</span>
          <h3 style={{ marginTop: 10 }}>{/* Safe by default: React escapes questionnaire questions. */}{item.question}</h3>
          <label className="label reveal-textarea">Your answer (optional)
            <textarea className="textarea" disabled={isRevealed} value={drafts[index] ?? ''} onChange={(event) => setDrafts((current) => ({ ...current, [index]: event.target.value }))} placeholder="Jot down your own answer before checking the model answer…" />
          </label>
          {!isRevealed
            ? <button className="gold-button" onClick={() => setRevealed((current) => ({ ...current, [index]: true }))}>Submit &amp; reveal model answer <ArrowRight size={15} /></button>
            : <div className="model-answer-block"><span className="eyebrow">Model answer</span><p className="summary-copy" style={{ marginTop: 8 }}>{/* Safe by default: React escapes model answers. */}{item.model_answer}</p><span className="small muted">Source page: {item.source_page ?? '—'}</span></div>}
          <div className="flow-nav">
            <button className="outline-button" disabled={flowIndex === 0} onClick={() => setFlowIndex((i) => Math.max(0, i - 1))}><ArrowLeft size={15} /> Previous</button>
            {!atLastItem && <button className="outline-button" disabled={!isRevealed} onClick={() => setFlowIndex((i) => Math.min(total - 1, i + 1))}>Next question <ArrowRight size={15} /></button>}
          </div>
        </article>;
      })()}
    </div>}
  </div>;
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMinutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(iso).toLocaleDateString();
}

const SET_KIND_LABEL: Record<string, string> = { quiz: 'Quiz', flashcards: 'Flashcards', questionnaire: 'Questionnaire' };

function Dashboard() {
  const { chatSessions, setActiveSessionId } = useWorkspace();
  const [, setLocation] = useLocation();
  const [sets, setSets] = useState<StudySetSummary[]>([]);
  const [dueCount, setDueCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.all([
      client.listStudySets().catch(() => [] as StudySetSummary[]),
      client.getDueFlashcards().catch(() => [] as DueFlashcard[]),
    ]).then(([setList, due]) => {
      if (!active) return;
      setSets(setList);
      setDueCount(due.length);
    }).catch((cause) => { if (active) setError(apiError(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  function resumeChat(sessionId: string) {
    setActiveSessionId(sessionId);
    setLocation('/chat');
  }
  function openSet(setId: string) {
    setLocation(`/study-tools?set=${encodeURIComponent(setId)}`);
  }

  type ActivityRow = { key: string; kind: 'chat' | 'quiz' | 'flashcards' | 'questionnaire'; title: string; meta: string; createdAt: string; onOpen: () => void };
  const activity: ActivityRow[] = [
    ...chatSessions.map((session): ActivityRow => ({
      key: `chat-${session.id}`, kind: 'chat', title: session.title || 'Untitled chat',
      meta: `${session.document_ids.length} document${session.document_ids.length === 1 ? '' : 's'}`,
      createdAt: session.created_at, onOpen: () => resumeChat(session.id),
    })),
    ...sets.map((set): ActivityRow => ({
      key: `set-${set.id}`, kind: set.kind as ActivityRow['kind'], title: set.title || `${SET_KIND_LABEL[set.kind] || set.kind} set`,
      meta: `${set.item_count} item${set.item_count === 1 ? '' : 's'}${set.document_filename ? ` · ${set.document_filename}` : ''}`,
      createdAt: set.created_at, onOpen: () => openSet(set.id),
    })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const quizCount = sets.filter((set) => set.kind === 'quiz').length;
  const flashcardSetCount = sets.filter((set) => set.kind === 'flashcards').length;
  const questionnaireCount = sets.filter((set) => set.kind === 'questionnaire').length;

  return <div className="page">
    <div className="page-heading"><div><span className="eyebrow">Your desk</span><h1>Dashboard.</h1><p>Everything you've generated, all in one place - jump back into a chat, quiz, flashcard deck, or questionnaire.</p></div><LayoutDashboard size={26} color="var(--gold)" /></div>
    {error && <p className="error-message" style={{ marginBottom: 20 }}>{error}</p>}
    <div className="grid grid-3" style={{ marginBottom: 28 }}>
      <div className="card stat-card"><span className="small muted">Chats</span><div className="stat-value">{chatSessions.length}</div><div className="stat-note">conversations saved</div></div>
      <div className="card stat-card"><span className="small muted">Study sets</span><div className="stat-value">{sets.length}</div><div className="stat-note">{quizCount} quiz · {flashcardSetCount} flashcard · {questionnaireCount} questionnaire</div></div>
      <div className="card stat-card"><span className="small muted">Due for review</span><div className="stat-value">{dueCount ?? '—'}</div><div className="stat-note"><Link href="/study-tools" className="gold-link">Open Recall Queue</Link></div></div>
    </div>
    <div className="overview-grid">
      <section className="card card-pad">
        <div className="section-title"><h2>Recent activity</h2></div>
        {loading ? <div className="empty-state">Loading your recent work…</div>
          : activity.length === 0 ? <div className="empty-state"><Clock size={26} /><h3>Nothing yet</h3><p>Start a chat or generate a study set to see it appear here.</p></div>
          : <div>{activity.slice(0, 20).map((row) => <button key={row.key} type="button" className="history-row" style={{ width: '100%', background: 'transparent', border: 0, cursor: 'pointer', textAlign: 'left' }} onClick={row.onOpen}>
            <div>
              <div className="history-row-title">{row.title}</div>
              <div className="history-row-meta">{row.meta}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className={`kind-badge ${row.kind}`}>{row.kind === 'chat' ? <MessageSquare size={11} /> : <BookOpen size={11} />} {row.kind === 'chat' ? 'Chat' : SET_KIND_LABEL[row.kind] || row.kind}</span>
              <span className="small muted">{timeAgo(row.createdAt)}</span>
            </div>
          </button>)}</div>}
      </section>
      <section className="card card-pad">
        <div className="section-title"><h2>Study tools</h2></div>
        <div className="grid" style={{ gap: 10 }}>
          <Link href="/study-tools" className="outline-button" style={{ justifyContent: 'space-between' }}><span><Brain size={15} style={{ marginRight: 8 }} />Generate a new set</span><ArrowRight size={14} /></Link>
          <Link href="/comparisons" className="outline-button" style={{ justifyContent: 'space-between' }}><span><FileText size={15} style={{ marginRight: 8 }} />Compare documents</span><ArrowRight size={14} /></Link>
        </div>
        <div className="rule" style={{ margin: '20px 0' }} />
        <span className="small muted">Recall Queue tracks flashcard review with real spaced repetition (SM-2) - questions you find hard come back sooner.</span>
      </section>
    </div>
  </div>;
}

function History() {
  const { chatSessions, setActiveSessionId } = useWorkspace();
  const [, setLocation] = useLocation();

  function resumeChat(sessionId: string) {
    setActiveSessionId(sessionId);
    setLocation('/chat');
  }

  const sorted = [...chatSessions].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return <div className="page">
    <div className="page-heading"><div><span className="eyebrow">Past conversations</span><h1>History.</h1><p>Every chat you've had with your library, newest first.</p></div><Clock size={26} color="var(--gold)" /></div>
    <section className="card card-pad">
      {sorted.length === 0
        ? <div className="empty-state"><MessageSquare size={26} /><h3>No conversations yet</h3><p>Start a new chat to see it appear here.</p></div>
        : <div>{sorted.map((session) => <button key={session.id} type="button" className="history-row" style={{ width: '100%', background: 'transparent', border: 0, cursor: 'pointer', textAlign: 'left' }} onClick={() => resumeChat(session.id)}>
          <div>
            <div className="history-row-title">{session.title || 'Untitled chat'}</div>
            <div className="history-row-meta">{session.document_ids.length} document{session.document_ids.length === 1 ? '' : 's'}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="kind-badge chat"><MessageSquare size={11} /> Chat</span>
            <span className="small muted">{timeAgo(session.created_at)}</span>
          </div>
        </button>)}</div>}
    </section>
  </div>;
}

function Library() {
  const { documents, openUpload, refreshDocuments, notify } = useWorkspace();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Keep the selection in sync when documents are removed or refreshed elsewhere.
  useEffect(() => {
    setSelected((current) => current.filter((id) => documents.some((doc) => doc.id === id)));
  }, [documents]);

  function toggle(id: string) {
    setSelected((current) => current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id]);
  }

  function toggleAll() {
    setSelected((current) => current.length === documents.length ? [] : documents.map((doc) => doc.id));
  }

  async function removeOne(id: string) {
    setBusy(true); setError('');
    try {
      await client.deleteDocument(id);
      await refreshDocuments();
      notify('Document deleted');
    } catch (cause) {
      setError(apiError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function removeSelected() {
    if (!selected.length || busy) return;
    setBusy(true); setError('');
    try {
      // Each deletion removes the file from disk and its vector index on
      // the backend (see documents.delete_document) - this isn't a soft
      // hide, the PDFs are actually gone from storage.
      const results = await Promise.allSettled(selected.map((id) => client.deleteDocument(id)));
      const failed = results.filter((result) => result.status === 'rejected').length;
      await refreshDocuments();
      setSelected([]);
      notify(failed
        ? `Deleted ${results.length - failed} of ${results.length} document${results.length === 1 ? '' : 's'} - ${failed} failed`
        : `${results.length} document${results.length === 1 ? '' : 's'} deleted`);
    } catch (cause) {
      setError(apiError(cause));
    } finally {
      setBusy(false);
    }
  }

  const allSelected = documents.length > 0 && selected.length === documents.length;

  return <div className="page">
    <div className="page-heading">
      <div><span className="eyebrow">Your papers</span><h1>Library.</h1><p>Upload, browse, and remove the PDFs in your workspace. Deleting a paper permanently removes its file and search index.</p></div>
      <div className="library-toolbar">
        {documents.length > 0 && <button className="outline-button" onClick={toggleAll}>{allSelected ? <CheckSquare size={15} /> : <Square size={15} />} {allSelected ? 'Deselect all' : 'Select all'}</button>}
        {selected.length > 0 && <button className="danger-button" disabled={busy} onClick={() => void removeSelected()}><Trash2 size={15} /> {busy ? 'Deleting…' : `Delete ${selected.length} selected`}</button>}
        <button className="gold-button" onClick={openUpload}><Upload size={15} /> Upload PDFs</button>
      </div>
    </div>
    {error && <p className="error-message" style={{ marginBottom: 20 }}>{error}</p>}
    {documents.length === 0
      ? <div className="empty-state"><FileText size={26} /><h3>No papers yet</h3><p>Upload your first PDF to start building your library.</p></div>
      : <div className="doc-grid">{documents.map((doc) => <article key={doc.id} className={`card doc-card ${selected.includes(doc.id) ? 'selected' : ''}`}>
          <input type="checkbox" className="selection-check" checked={selected.includes(doc.id)} onChange={() => toggle(doc.id)} aria-label={`Select ${displayName(doc)}`} />
          <div className="doc-cover"><FileText size={30} /></div>
          <div className="doc-card-body">
            <span className="doc-card-title">{displayName(doc)}</span>
            <div className="doc-card-meta"><Status doc={doc} /><span>{doc.page_count ? `${doc.page_count} page${doc.page_count === 1 ? '' : 's'}` : '—'}</span></div>
            <div className="action-row" style={{ marginTop: 14 }}>
              <button className="outline-button" disabled={busy} onClick={() => void removeOne(doc.id)}><Trash2 size={14} /> Delete</button>
            </div>
          </div>
        </article>)}</div>}
  </div>;
}

function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const [, setLocation] = useLocation();
  const { login, register } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { if (mode === 'login') await login(email, password); else await register(email, password, fullName || undefined); setLocation('/'); } catch (cause) { setError(apiError(cause)); } finally { setBusy(false); }
  }
  return <div className="auth-page"><section className="auth-art"><div className="auth-art-content"><span className="eyebrow" style={{ color: '#ddbd62' }}>PDF Assistant · Academic research</span><h1>Read deeply.<br />Think clearly.</h1><p>A quiet research companion for the papers that shape your work.</p></div></section><section className="auth-form-wrap"><form className="auth-form" onSubmit={submit}><Brand /><span className="eyebrow" style={{ display: 'block', marginTop: 45 }}>{mode === 'login' ? 'Welcome back' : 'Begin your workspace'}</span><h2>{mode === 'login' ? 'Return to your reading.' : 'Create a research desk.'}</h2><p className="muted">{mode === 'login' ? 'Sign in to continue your research practice.' : 'A considered place for papers, questions, and ideas.'}</p><div className="auth-form-fields">{mode === 'register' && <label className="label">Full name<input className="field" value={fullName} onChange={(event) => setFullName(event.target.value)} /></label>}<label className="label">Email address<input className="field" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@institution.edu" /></label><label className="label">Password<input className="field" type="password" required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" /></label></div>{error && <p className="error-message">{error}</p>}<button className="gold-button" style={{ width: '100%' }} disabled={busy}>{busy ? 'Working…' : mode === 'login' ? 'Enter workspace' : 'Create account'} <ArrowRight size={15} /></button>{mode === 'login' && <><button type="button" className="outline-button" style={{ width: '100%', marginTop: 10 }} onClick={() => client.googleLoginRedirect()}><LockKeyhole size={15} /> Continue with Google</button><Link href="/reset-password" className="gold-link auth-reset-link">Forgot your password?</Link></>}<p className="auth-foot">{mode === 'login' ? 'New to PDF Assistant?' : 'Already have an account?'} <Link href={mode === 'login' ? '/register' : '/login'} className="gold-link">{mode === 'login' ? 'Create an account' : 'Sign in'}</Link></p></form></section></div>;
}

function PasswordResetPage() {
  const initialToken = new URLSearchParams(window.location.search).get('token') || '';
  const [email, setEmail] = useState('');
  const [token, setToken] = useState(initialToken);
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetMode, setResetMode] = useState(Boolean(initialToken));

  async function requestReset(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await client.requestPasswordReset(email);
      setMessage(response.reset_token ? 'Development reset link is ready below.' : response.message);
      if (response.reset_token) {
        setToken(response.reset_token);
        setResetMode(true);
      }
    } catch (cause) {
      setError(apiError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await client.resetPassword(token, newPassword);
      setMessage(response.message);
      setNewPassword('');
    } catch (cause) {
      setError(apiError(cause));
    } finally {
      setBusy(false);
    }
  }

  return <div className="auth-page utility-auth-page"><section className="auth-art"><div className="auth-art-content"><span className="eyebrow" style={{ color: '#ddbd62' }}>Account recovery</span><h1>Return to your<br />research desk.</h1><p>A short-lived link keeps your account recovery private and focused.</p></div></section><section className="auth-form-wrap"><div className="auth-form"><Brand /><span className="eyebrow" style={{ display: 'block', marginTop: 45 }}>{resetMode ? 'Choose a new password' : 'Forgotten password'}</span><h2>{resetMode ? 'Set a fresh password.' : 'Request a reset link.'}</h2><p className="muted">{resetMode ? 'Use at least eight characters, then return to sign in.' : 'Enter your account email and we will prepare a secure, short-lived link.'}</p>{resetMode ? <form className="auth-form-fields" onSubmit={submitReset}><label className="label">Reset token<input className="field" required value={token} onChange={(event) => setToken(event.target.value)} /></label><label className="label">New password<input className="field" type="password" required minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="At least 8 characters" /></label><button className="gold-button" disabled={busy}>{busy ? 'Updating…' : 'Update password'} <ArrowRight size={15} /></button></form> : <form className="auth-form-fields" onSubmit={requestReset}><label className="label">Email address<input className="field" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@institution.edu" /></label><button className="gold-button" disabled={busy}>{busy ? 'Preparing…' : 'Prepare reset link'} <ArrowRight size={15} /></button></form>}{message && <p className="success-message">{message}</p>}{error && <p className="error-message">{error}</p>}<p className="auth-foot"><Link href="/login" className="gold-link">Return to sign in</Link></p></div></section></div>;
}

function VerifyEmailPage() {
  const [token, setToken] = useState(() => new URLSearchParams(window.location.search).get('token') || '');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await client.verifyEmail(token);
      setMessage(response.message);
    } catch (cause) {
      setError(apiError(cause));
    } finally {
      setBusy(false);
    }
  }

  return <div className="auth-page utility-auth-page"><section className="auth-art"><div className="auth-art-content"><span className="eyebrow" style={{ color: '#ddbd62' }}>Account verification</span><h1>Make your<br />desk official.</h1><p>Confirm the email that belongs to your research workspace.</p></div></section><section className="auth-form-wrap"><form className="auth-form" onSubmit={submit}><Brand /><span className="eyebrow" style={{ display: 'block', marginTop: 45 }}>Email verification</span><h2>Confirm your address.</h2><p className="muted">Paste the short-lived verification token from your email.</p><label className="label">Verification token<input className="field" required value={token} onChange={(event) => setToken(event.target.value)} /></label><button className="gold-button" disabled={busy}>{busy ? 'Verifying…' : 'Verify email'} <ArrowRight size={15} /></button>{message && <p className="success-message">{message}</p>}{error && <p className="error-message">{error}</p>}<p className="auth-foot"><Link href="/login" className="gold-link">Return to sign in</Link></p></form></section></div>;
}

function OAuthCallbackPage() {
  const [, setLocation] = useLocation();
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    // A single failed check right after the OAuth redirect can be a harmless
    // timing blip (the auth cookie was already set by the backend's redirect
    // response, but the very first request to confirm it can occasionally
    // race that) rather than a real auth failure. Retry a few times with a
    // short delay before actually giving up, instead of bouncing the user
    // to /login on the very first hiccup and discarding a valid session.
    const attemptConfirmation = async () => {
      const maxAttempts = 4;
      const delayMs = 400;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (!active) return;
        try {
          await client.me();
          if (active) setLocation('/');
          return;
        } catch (cause) {
          lastError = cause;
          if (attempt < maxAttempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
      }
      if (active) {
        setError(apiError(lastError));
        setLocation('/login');
      }
    };
    void attemptConfirmation();
    return () => {
      active = false;
    };
  }, [setLocation]);

  return <div className="auth-page"><div className="empty-state" style={{ margin: 'auto' }}>{error ? 'Unable to confirm Google sign-in.' : 'Confirming your Google session…'}</div></div>;
}

function Settings() {
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem('pdf-assistant-openrouter-key') || '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [deactivationError, setDeactivationError] = useState('');
  const [deactivationBusy, setDeactivationBusy] = useState(false);
  const { notify } = useWorkspace();
  const { user, deactivateAccount } = useAuth();
  const [, setLocation] = useLocation();

  async function submitDeactivation(event: React.FormEvent) {
    event.preventDefault();
    setDeactivationBusy(true);
    setDeactivationError('');
    try {
      await deactivateAccount(currentPassword);
      setLocation('/login');
    } catch (cause) {
      setDeactivationError(apiError(cause));
    } finally {
      setDeactivationBusy(false);
    }
  }

  return <div className="page">
    <div className="page-heading"><div><span className="eyebrow">Workspace controls</span><h1>Settings.</h1><p>Your account and preferences for this workspace.</p></div></div>
    <section className="card profile-hero" style={{ marginBottom: 24 }}>
      <div className="avatar-large">{(user?.email?.[0] || 'R').toUpperCase()}</div>
      <div><span className="eyebrow">Account</span><h2 className="profile-name">{user?.full_name || user?.email}</h2><p className="muted serif">{user?.email}</p></div>
    </section>
    <section className="card card-pad"><div className="section-title"><h2>AI preferences</h2><Sparkles size={19} color="var(--gold)" /></div><label className="label">Optional OpenRouter API key<input className="field" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label><p className="muted small">Stored in sessionStorage only and sent per request. This is a known tradeoff to revisit when a backend-issued httpOnly-cookie flow is available; it is not stored in localStorage.</p><button className="gold-button" onClick={() => { sessionStorage.setItem('pdf-assistant-openrouter-key', apiKey); notify('AI preferences saved'); }}>Save preferences</button></section>
    <section className="card card-pad" style={{ marginTop: 24 }}><div className="section-title"><h2>Deactivate account</h2><LockKeyhole size={19} color="var(--gold)" /></div><p className="muted">This permanently signs you out and disables future sign-ins. Re-enter your current password to confirm.</p><form className="auth-form-fields" onSubmit={submitDeactivation}><label className="label">Current password<input className="field" type="password" required minLength={8} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>{deactivationError && <p className="error-message">{deactivationError}</p>}<button className="outline-button" type="submit" disabled={deactivationBusy}>{deactivationBusy ? 'Deactivating…' : 'Deactivate account'}</button></form></section>
  </div>;
}

function NotFoundPage() {
  return <div className="empty-state" style={{ margin: 50 }}><CircleHelp size={30} /><h1>Page not found</h1><Link className="gold-button" href="/">Return home</Link></div>;
}

function ChatRoute() {
  const { activeSessionId } = useWorkspace();
  // Remount Chat entirely on every session switch (including back to a
  // brand-new chat) instead of reconciling six pieces of local state by
  // hand - this is what keeps a previous conversation's state from ever
  // leaking into the next one.
  return <Chat key={activeSessionId ?? 'new'} />;
}

function OverviewRedirect() {
  const [, setLocation] = useLocation();
  useEffect(() => { setLocation('/dashboard'); }, [setLocation]);
  return null;
}

function ProtectedApp() {
  const { user, loading } = useAuth();
  if (loading) return <div className="auth-page"><div className="empty-state" style={{ margin: 'auto' }}>Restoring your research desk…</div></div>;
  if (!user) return <AuthPage mode="login" />;
  return <WorkspaceProvider><Shell><Switch>
    <Route path="/" component={ChatRoute} />
    <Route path="/chat" component={ChatRoute} />
    <Route path="/history" component={History} />
    <Route path="/study-tools" component={StudyTools} />
    <Route path="/comparisons" component={Comparisons} />
    <Route path="/library" component={Library} />
    <Route path="/dashboard" component={Dashboard} />
    <Route path="/overview" component={OverviewRedirect} />
    <Route path="/settings" component={Settings} />
    <Route component={NotFoundPage} />
  </Switch></Shell></WorkspaceProvider>;
}

function Router() {
  return <Switch><Route path="/login"><AuthPage mode="login" /></Route><Route path="/register"><AuthPage mode="register" /></Route><Route path="/reset-password"><PasswordResetPage /></Route><Route path="/verify-email"><VerifyEmailPage /></Route><Route path="/oauth-callback"><OAuthCallbackPage /></Route><Route><ProtectedApp /></Route></Switch>;
}

export default function App() {
  return <Router />;
}