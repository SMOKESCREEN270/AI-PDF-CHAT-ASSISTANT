import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowRight,
  BookOpen,
  Brain,
  Check,
  CircleHelp,
  FileText,
  LockKeyhole,
  MessageSquare,
  Plus,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
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
} from '@/api/client';
import { useAuth } from '@/context/AuthContext';
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
  { href: '/comparisons', label: 'Comparisons', icon: ArrowRight },
  { href: '/study-tools', label: 'Study Tools', icon: BookOpen },
];

function Shell({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const { chatSessions, setActiveSessionId } = useWorkspace();
  const { user, logout } = useAuth();

  function startNewChat() {
    setActiveSessionId(null);
    setLocation('/chat');
  }
  function resumeChat(sessionId: string) {
    setActiveSessionId(sessionId);
    setLocation('/chat');
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <Brand />
      <button className="upload-button" onClick={startNewChat}><Plus size={15} /> New chat</button>
      <nav className="side-nav">{navigation.map(({ href, label, icon: Icon }) => <Link key={href} href={href} className={`nav-link ${location === href ? 'active' : ''}`}><Icon size={18} /><span className="nav-label">{label}</span></Link>)}</nav>
      <div className="chats-list-section">
        <span className="eyebrow chats-list-heading">Chats</span>
        <div className="chats-list">
          {chatSessions.length === 0 && <span className="small muted chats-list-empty">No conversations yet</span>}
          {chatSessions.map((session) => <button key={session.id} type="button" className="chat-list-item" onClick={() => resumeChat(session.id)}>
            <MessageSquare size={14} />
            <span className="chat-list-item-title">{session.title || 'Untitled chat'}</span>
          </button>)}
        </div>
      </div>
      <div className="sidebar-bottom">
        <Link href="/settings" className={`nav-link ${location === '/settings' ? 'active' : ''}`}><SettingsIcon size={18} /><span className="nav-label">Settings</span></Link>
        <div className="profile-mini"><span className="avatar">{(user?.email?.[0] || 'R').toUpperCase()}</span><span><b>{user?.full_name || user?.email || 'Researcher'}</b></span></div>
        <button className="outline-button" onClick={logout}>Sign out</button>
      </div>
    </aside>
    <main className="main-area">
      {children}
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
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem('pdf-assistant-gemini-key') || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    if (!files.length) return;
    setBusy(true); setError('');
    try {
      const uploaded = await client.uploadDocuments(files, apiKey || undefined);
      sessionStorage.setItem('pdf-assistant-gemini-key', apiKey);
      await refreshDocuments();
      if (uploaded[0]) setSelectedId(uploaded[0].id);
      notify(`${uploaded.length} document${uploaded.length === 1 ? '' : 's'} uploaded`);
      onClose();
    } catch (cause) { setError(apiError(cause)); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true">
    <div className="section-title"><div><span className="eyebrow">Library intake</span><h2>Add papers</h2></div><button className="icon-button" onClick={onClose}><X size={19} /></button></div>
    <label className="dropzone"><Upload size={25} /><strong>{files.length ? `${files.length} PDF${files.length === 1 ? '' : 's'} selected` : 'Choose PDF files'}</strong><span className="muted small">The backend will process and index them for grounded answers.</span><input type="file" accept=".pdf,application/pdf" multiple hidden onChange={(event) => setFiles(Array.from(event.target.files || []))} /></label>
    <label className="label">Optional Gemini API key<input className="field" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Used for this request only" /></label>
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
  return <div className="export-control">
    <select className="select" aria-label={`${label} format`} value={format} onChange={(event) => setFormat(event.target.value)} disabled={!refId || busy}>
      <option value="pdf">PDF</option>
      <option value="docx">Word</option>
      <option value="markdown">Markdown</option>
      <option value="json">JSON</option>
    </select>
    <button className="outline-button" disabled={!refId || busy} onClick={() => void download()}>{busy ? 'Preparing…' : label}</button>
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

  return <div className="export-control">
    {options.length > 1 && <select className="select" aria-label="What to export" value={selectedKind} onChange={(event) => setSelectedKind(event.target.value)}>
      {options.map((option) => <option key={option.kind} value={option.kind}>{option.label}</option>)}
    </select>}
    <select className="select" aria-label="Export format" value={format} onChange={(event) => setFormat(event.target.value)} disabled={!refId || busy}>
      <option value="pdf">PDF</option>
      <option value="docx">Word</option>
      <option value="markdown">Markdown</option>
      <option value="json">JSON</option>
    </select>
    <button className="outline-button" disabled={!refId || busy} onClick={() => void download()}>{busy ? 'Preparing…' : 'Export'}</button>
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
  const [loadingSession, setLoadingSession] = useState(false);
  const [error, setError] = useState('');
  const [activeCitation, setActiveCitation] = useState<Citation | null>(null);

  // Default to the most recently uploaded ready document for a brand-new chat.
  useEffect(() => {
    if (activeSessionId || chosen.length) return;
    const firstReady = documents.find((doc) => doc.status === 'ready');
    if (firstReady) setChosen([firstReady.id]);
  }, [activeSessionId, chosen.length, documents]);

  // Resuming a chat picked from the sidebar: load its history and restore
  // which documents it was scoped to.
  useEffect(() => {
    if (!activeSessionId || activeSessionId === sessionId) return;
    let active = true;
    setLoadingSession(true);
    setError('');
    void client.getSessionMessages(activeSessionId)
      .then((history) => {
        if (!active) return;
        setMessages(history);
        setSessionId(activeSessionId);
        setLastResponse(null);
        const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
        void client.listSessions().then((sessions) => {
          const match = sessions.find((s) => s.id === activeSessionId);
          if (match && active) setChosen(match.document_ids);
        });
        void lastAssistant;
      })
      .catch((cause) => { if (active) setError(apiError(cause)); })
      .finally(() => { if (active) setLoadingSession(false); });
    return () => { active = false; };
  }, [activeSessionId, sessionId]);

  async function send() {
    if (!input.trim() || !chosen.length || busy) return;
    const question = input.trim();
    setInput('');
    setBusy(true);
    setError('');
    setMessages((current) => [...current, { role: 'user', content: question }]);
    try {
      const storedKey = sessionStorage.getItem('pdf-assistant-gemini-key');
      const isNewSession = !sessionId;
      const response = await client.chat({
        document_ids: chosen,
        message: question,
        session_id: sessionId,
        user_api_key: storedKey ? { provider: 'gemini', api_key: storedKey } : null,
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
              {message.hallucination_flag && <div className="warning-message" style={{ marginTop: 12 }}>Review warning: the answer has lower source confidence. Check the citations carefully.</div>}
              {message.summary && <div className="card card-pad" style={{ marginTop: 14 }}>
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
    try { setResult(await client.compareDocuments({ document_ids: chosen, scenario_context: scenario || undefined })); notify('Synthesis refreshed'); } catch (cause) { setError(apiError(cause)); } finally { setBusy(false); }
  }
  return <div className="page">
    <div className="page-heading">
      <div><span className="eyebrow">Literature mapping</span><h1>Compare the field.</h1><p>Ask Gemini to compare real excerpts from your selected documents.</p></div>
      <div className="action-row"><button className="gold-button" disabled={busy} onClick={() => void compare()}><Sparkles size={15} /> {busy ? 'Synthesizing…' : 'Synthesize selection'}</button>{result && <ExportControl kind="comparison" refId="comparison-result" data={result as unknown as Record<string, unknown>} label="Export comparison" />}</div>
    </div>
    <div className="card card-pad" style={{ marginBottom: 28 }}>
      <div className="section-title"><h2>Select papers</h2><span className="status-pill">{chosen.length} selected</span></div>
      <div className="grid grid-2">{documents.filter((doc) => doc.status === 'ready').map((doc) => <label key={doc.id} className={`option ${chosen.includes(doc.id) ? 'selected' : ''}`}><input type="checkbox" checked={chosen.includes(doc.id)} onChange={() => setChosen((current) => current.includes(doc.id) ? current.filter((id) => id !== doc.id) : [...current, doc.id])} /> <strong>{displayName(doc)}</strong></label>)}</div>
      <label className="label" style={{ marginTop: 20 }}>Scenario context<input className="field" value={scenario} onChange={(event) => setScenario(event.target.value)} placeholder="For a beginner ML student, a thesis review, or your own context" /></label>
      {error && <p className="error-message">{error}</p>}
    </div>
     {result && <><section className="card card-pad accent-card"><div className="section-title"><h2>AI synthesis</h2><Sparkles size={20} color="var(--gold)" /></div><div className="table-wrap"><table className="matrix"><thead><tr><th>Dimension</th>{result.table.map((row) => <th key={row.document}>{/* Safe by default: React escapes backend-generated document labels. */}{row.document}</th>)}</tr></thead><tbody>{result.dimensions.map((dimension) => <tr key={dimension}><td>{/* Safe by default: React escapes backend-generated dimensions. */}{dimension}</td>{result.table.map((row) => <td key={`${row.document}-${dimension}`} className="serif">{/* Safe by default: React escapes backend-generated comparison values. */}{row.values[dimension] || '—'}</td>)}</tr>)}</tbody></table></div></section><section style={{ marginTop: 28 }}><h2>Recommendations</h2><div className="grid grid-2" style={{ marginTop: 16 }}>{result.recommendations.map((recommendation) => <article className="card card-pad" key={`${recommendation.scenario}-${recommendation.best_document}`}><span className="eyebrow">{/* Safe by default: React escapes backend-generated recommendation scenarios. */}{recommendation.scenario}</span><h3 style={{ marginTop: 8 }}>{/* Safe by default: React escapes backend-generated document names. */}{recommendation.best_document}</h3><p className="serif">{/* Safe by default: React escapes backend-generated recommendation text. */}{recommendation.reason}</p></article>)}</div></section></>}
  </div>;
}

function StudyTools() {
  const { documents } = useWorkspace();
  const [tab, setTab] = useState<'quiz' | 'flashcards' | 'questionnaire'>('quiz');
  const [view, setView] = useState<'generator' | 'due'>('generator');
  const [documentId, setDocumentId] = useState('');
  const [items, setItems] = useState<Array<QuizItem | FlashcardItem | QuestionnaireItem>>([]);
  const [setId, setSetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [flipped, setFlipped] = useState<Record<number, boolean>>({});
  const [dueCards, setDueCards] = useState<DueFlashcard[]>([]);
  const [dueBusy, setDueBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);
  const readyDocs = documents.filter((doc) => doc.status === 'ready');

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
    setAnswers({});
    setChecked({});
    setFlipped({});
    try {
      const key = sessionStorage.getItem('pdf-assistant-gemini-key');
      const auth = key ? { provider: 'gemini', api_key: key } : null;
      const response = tab === 'quiz'
        ? await client.generateQuiz({ document_id: documentId, num_questions: 8, user_api_key: auth })
        : tab === 'flashcards'
          ? await client.generateFlashcards({ document_id: documentId, num_cards: 10, user_api_key: auth })
          : await client.generateQuestionnaire({ document_id: documentId, num_questions: 8, user_api_key: auth });
      setItems(response.items);
      setSetId(response.set_id);
    } catch (cause) {
      setError(apiError(cause));
    } finally {
      setBusy(false);
    }
  }

  return <div className="page">
    <div className="page-heading"><div><span className="eyebrow">Active recall studio</span><h1>Study with intention.</h1><p>Generate exercises from a real uploaded document and keep scoring in this session.</p></div><Brain size={26} color="var(--gold)" /></div>
    <div className="tool-tabs">
      {(['quiz', 'flashcards', 'questionnaire'] as const).map((key) => <button key={key} className={`tool-tab ${view === 'generator' && tab === key ? 'active' : ''}`} onClick={() => { setView('generator'); setTab(key); setItems([]); setSetId(''); }}>{key[0].toUpperCase() + key.slice(1)}</button>)}
      <button className={`tool-tab ${view === 'due' ? 'active' : ''}`} onClick={() => { setView('due'); void loadDueCards(); }}>Due for review {dueCards.length > 0 && <span className="status-pill">{dueCards.length}</span>}</button>
    </div>
    {view === 'generator' && <div className="card card-pad" style={{ marginBottom: 24 }}>
      <div className="action-row"><label className="label" style={{ flex: 1 }}>Source document<select className="select" value={documentId} onChange={(event) => setDocumentId(event.target.value)}><option value="">Choose a ready document</option>{readyDocs.map((doc) => <option key={doc.id} value={doc.id}>{displayName(doc)}</option>)}</select></label><button className="gold-button" disabled={busy} onClick={() => void generate()}>{busy ? 'Generating…' : 'Generate set'} <ArrowRight size={15} /></button></div>
      {error && <p className="error-message">{error}</p>}
    </div>}
    {view === 'due' && <section>
      <div className="section-title"><div><span className="eyebrow">Spaced repetition</span><h2>Due for review</h2></div><button className="outline-button" disabled={dueBusy} onClick={() => void loadDueCards()}>{dueBusy ? 'Refreshing…' : 'Refresh'}</button></div>
      {error && <p className="error-message">{error}</p>}
      {dueBusy && !dueCards.length ? <div className="empty-state">Loading cards due now…</div> : dueCards.length ? <div className="grid grid-2">{dueCards.map((card) => <article className="card card-pad" key={card.flashcard_id}>
        <span className="eyebrow">Review card</span>
        <h3 style={{ margin: '12px 0' }}>{/* Safe by default: React escapes flashcard front content. */}{card.front}</h3>
        <p className="summary-copy">{/* Safe by default: React escapes flashcard back content. */}{card.back}</p>
        <div className="action-row" style={{ marginTop: 18 }}><button className="outline-button" disabled={reviewBusy === card.flashcard_id} onClick={() => void reviewCard(card.flashcard_id, 2)}>Hard</button><button className="outline-button" disabled={reviewBusy === card.flashcard_id} onClick={() => void reviewCard(card.flashcard_id, 4)}>Good</button><button className="gold-button" disabled={reviewBusy === card.flashcard_id} onClick={() => void reviewCard(card.flashcard_id, 5)}>Easy</button></div>
      </article>)}</div> : <div className="empty-state"><Check size={26} /><h3>Nothing due right now</h3><p>Generate flashcards or check back after your next review interval.</p></div>}
    </section>}
    {setId && <div className="action-row" style={{ margin: '15px 0' }}><p className="small muted">Set {setId.slice(0, 8)} · {items.length} generated items</p><ExportControl kind={tab} refId={setId} label={`Export ${tab}`} /></div>}
    {view === 'generator' && tab === 'quiz' && <div className="grid grid-2">{(items as QuizItem[]).map((item, index) => <section className="card card-pad" key={`${item.question}-${index}`}>
      <span className="eyebrow">Question {index + 1}</span>
      <h3 style={{ margin: '10px 0 15px' }}>{/* Safe by default: React escapes quiz questions. */}{item.question}</h3>
      <div style={{ display: 'grid', gap: 9 }}>{item.options.map((option, optionIndex) => <button key={option} className={`option ${answers[index] === optionIndex ? 'selected' : ''}`} onClick={() => setAnswers((current) => ({ ...current, [index]: optionIndex }))}>{/* Safe by default: React escapes quiz options. */}{option}{answers[index] === optionIndex && <Check size={16} style={{ float: 'right', color: 'var(--gold-deep)' }} />}</button>)}</div>
      <button className="gold-button" style={{ marginTop: 15 }} disabled={answers[index] === undefined} onClick={() => setChecked((current) => ({ ...current, [index]: true }))}>Check answer</button>
      {checked[index] && <p className={answers[index] === item.correct_index ? 'success-message' : 'error-message'}>{answers[index] === item.correct_index ? 'Correct.' : `Not quite. Correct answer: ${item.options[item.correct_index]}`} {/* Safe by default: React escapes quiz explanations. */}{item.explanation}</p>}
    </section>)}</div>}
    {view === 'generator' && tab === 'flashcards' && <div className="grid grid-2">{(items as FlashcardItem[]).map((item, index) => <article className="card card-pad" key={`${item.id || item.front}-${index}`}>
      <button className="flashcard-face" onClick={() => setFlipped((current) => ({ ...current, [index]: !current[index] }))}>
        <span className="eyebrow">{flipped[index] ? 'Answer' : 'Prompt'} · Card {index + 1}</span>
        <h3 style={{ marginTop: 18 }}>{/* Safe by default: React escapes flashcard front/back content. */}{flipped[index] ? item.back : item.front}</h3>
        <span className="small muted" style={{ display: 'block', marginTop: 18 }}>Click to {flipped[index] ? 'show prompt' : 'reveal answer'}</span>
      </button>
      {flipped[index] && item.id && <div className="action-row" style={{ marginTop: 18 }}><button className="outline-button" disabled={reviewBusy === item.id} onClick={() => void reviewCard(item.id!, 2)}>Hard</button><button className="outline-button" disabled={reviewBusy === item.id} onClick={() => void reviewCard(item.id!, 4)}>Good</button><button className="gold-button" disabled={reviewBusy === item.id} onClick={() => void reviewCard(item.id!, 5)}>Easy</button></div>}
    </article>)}</div>}
    {view === 'generator' && tab === 'questionnaire' && <div className="grid grid-2">{(items as QuestionnaireItem[]).map((item, index) => <article className="card card-pad" key={`${item.question}-${index}`}>
      <span className="eyebrow">{item.type} · Question {index + 1}</span>
      <h3 style={{ marginTop: 10 }}>{/* Safe by default: React escapes questionnaire questions. */}{item.question}</h3>
      <p className="summary-copy">{/* Safe by default: React escapes model answers. */}{item.model_answer}</p>
      <span className="small muted">Source page: {item.source_page ?? '—'}</span>
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
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem('pdf-assistant-gemini-key') || '');
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
    <section className="card card-pad"><div className="section-title"><h2>AI preferences</h2><Sparkles size={19} color="var(--gold)" /></div><label className="label">Optional Gemini API key<input className="field" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label><p className="muted small">Stored in sessionStorage only and sent per request. This is a known tradeoff to revisit when a backend-issued httpOnly-cookie flow is available; it is not stored in localStorage.</p><button className="gold-button" onClick={() => { sessionStorage.setItem('pdf-assistant-gemini-key', apiKey); notify('AI preferences saved'); }}>Save preferences</button></section>
    <section className="card card-pad" style={{ marginTop: 24 }}><div className="section-title"><h2>Deactivate account</h2><LockKeyhole size={19} color="var(--gold)" /></div><p className="muted">This permanently signs you out and disables future sign-ins. Re-enter your current password to confirm.</p><form className="auth-form-fields" onSubmit={submitDeactivation}><label className="label">Current password<input className="field" type="password" required minLength={8} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>{deactivationError && <p className="error-message">{deactivationError}</p>}<button className="outline-button" type="submit" disabled={deactivationBusy}>{deactivationBusy ? 'Deactivating…' : 'Deactivate account'}</button></form></section>
  </div>;
}

function NotFoundPage() {
  return <div className="empty-state" style={{ margin: 50 }}><CircleHelp size={30} /><h1>Page not found</h1><Link className="gold-button" href="/">Return home</Link></div>;
}

function ProtectedApp() {
  const { user, loading } = useAuth();
  if (loading) return <div className="auth-page"><div className="empty-state" style={{ margin: 'auto' }}>Restoring your research desk…</div></div>;
  if (!user) return <AuthPage mode="login" />;
  return <WorkspaceProvider><Shell><Switch><Route path="/" component={Chat} /><Route path="/chat" component={Chat} /><Route path="/comparisons" component={Comparisons} /><Route path="/study-tools" component={StudyTools} /><Route path="/settings" component={Settings} /><Route component={NotFoundPage} /></Switch></Shell></WorkspaceProvider>;
}

function Router() {
  return <Switch><Route path="/login"><AuthPage mode="login" /></Route><Route path="/register"><AuthPage mode="register" /></Route><Route path="/reset-password"><PasswordResetPage /></Route><Route path="/verify-email"><VerifyEmailPage /></Route><Route path="/oauth-callback"><OAuthCallbackPage /></Route><Route><ProtectedApp /></Route></Switch>;
}

export default function App() {
  return <Router />;
}