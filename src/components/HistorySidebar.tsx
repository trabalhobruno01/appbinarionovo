import { useState, type FormEvent } from 'react';
import {
  FolderKanban,
  FolderPlus,
  Image as ImageIcon,
  LogOut,
  MessageSquarePlus,
  Trash2,
  X,
} from 'lucide-react';
import type { Conversation, Project } from '../../shared/types.ts';

interface HistorySidebarProps {
  open: boolean;
  projects: Project[];
  activeProjectId: string;
  conversations: Conversation[];
  activeId: string;
  isAuthenticated: boolean;
  onSelectProject: (projectId: string) => void;
  onCreateProject: (name: string) => Promise<void>;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
  onOpenAudit?: () => void;
  onLogout: () => Promise<void>;
  onClose: () => void;
}

export function HistorySidebar({
  open,
  projects,
  activeProjectId,
  conversations,
  activeId,
  isAuthenticated,
  onSelectProject,
  onCreateProject,
  onSelect,
  onNewChat,
  onDelete,
  onLogout,
  onClose,
}: HistorySidebarProps) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [savingProject, setSavingProject] = useState(false);

  const handleCreateProjectSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = newProjectName.trim();
    if (!clean || savingProject) return;
    setSavingProject(true);
    try {
      await onCreateProject(clean);
      setNewProjectName('');
      setCreatingProject(false);
    } finally {
      setSavingProject(false);
    }
  };

  const sidebarContent = (
    <div className="flex h-full flex-col bg-white text-slate-900 dark:bg-[#0F141E] dark:text-slate-100">
      <div className="pt-safe flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <span className="font-display text-sm font-semibold">
          Histórico de Análises
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              onNewChat();
              onClose();
            }}
            className="flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-emerald-600 hover:bg-slate-100 dark:text-emerald-400 dark:hover:bg-slate-800"
          >
            <MessageSquarePlus className="h-4 w-4" />
            <span>Nova</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar histórico"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 lg:hidden dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Independent User Projects Switcher */}
      <div className="border-b border-slate-200 px-3 py-2.5 dark:border-slate-800">
        <div className="flex items-center gap-1.5">
          <FolderKanban className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <select
            aria-label="Selecionar projeto"
            value={activeProjectId}
            onChange={(e) => onSelectProject(e.target.value)}
            className="h-9 min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-2 text-xs font-medium text-slate-800 focus:border-emerald-500 focus:outline-none dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setCreatingProject((prev) => !prev)}
            aria-label="Criar novo projeto"
            title="Novo projeto"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <FolderPlus className="h-4 w-4" />
          </button>
        </div>

        {creatingProject && (
          <form onSubmit={handleCreateProjectSubmit} className="mt-2 flex items-center gap-1.5">
            <input
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="Nome do projeto..."
              maxLength={80}
              disabled={savingProject}
              className="h-9 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
            <button
              type="submit"
              disabled={savingProject || !newProjectName.trim()}
              className="h-9 rounded-lg bg-emerald-500 px-2.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
            >
              Criar
            </button>
          </form>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
        {conversations.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-slate-500 dark:text-slate-400">
            Suas conversas e fotografias analisadas aparecerão aqui automaticamente.
          </div>
        ) : (
          conversations.map((conv) => {
            const firstImg = conv.messages.find((m) => m.imageDataUrl)?.imageDataUrl;
            const lastAnalysis = [...conv.messages].reverse().find((m) => m.analysis)?.analysis;
            const isActive = conv.id === activeId;
            const isConfirming = confirmDeleteId === conv.id;

            return (
              <div
                key={conv.id}
                className={`group rounded-xl border transition-colors ${
                  isActive
                    ? 'border-emerald-500/40 bg-emerald-500/5 dark:bg-emerald-500/10'
                    : 'border-transparent hover:border-slate-200 hover:bg-slate-50 dark:hover:border-slate-800 dark:hover:bg-slate-900/50'
                }`}
              >
                <div className="flex items-center gap-2.5 p-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(conv.id);
                      onClose();
                    }}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-900">
                      {firstImg ? (
                        <img
                          src={firstImg}
                          alt={conv.title}
                          referrerPolicy="no-referrer"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <ImageIcon className="h-4 w-4 text-slate-400" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                        {conv.title}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                        {lastAnalysis && (
                          <>
                            <span className="font-semibold">{lastAnalysis.decision}</span>
                            <span aria-hidden="true">·</span>
                          </>
                        )}
                        <span className="font-mono-tabular truncate">{conv.updatedAtBrt}</span>
                      </div>
                    </div>
                  </button>

                  {isConfirming ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          onDelete(conv.id);
                          setConfirmDeleteId(null);
                        }}
                        className="min-h-[36px] rounded-lg bg-rose-600 px-2.5 text-xs font-semibold text-white hover:bg-rose-500"
                      >
                        Excluir
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="min-h-[36px] rounded-lg px-2 text-xs text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800"
                      >
                        Não
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(conv.id)}
                      aria-label={`Excluir conversa ${conv.title}`}
                      className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg text-slate-400 hover:bg-slate-200/70 hover:text-rose-600 dark:hover:bg-slate-800 dark:hover:text-rose-400"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {isAuthenticated && (
        <div className="pb-safe border-t border-slate-200 p-3 dark:border-slate-800">
          <button
            type="button"
            onClick={() => {
              onClose();
              void onLogout();
            }}
            className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-rose-500/25 bg-rose-500/5 px-3 text-xs font-semibold tracking-wide text-rose-600 transition-colors hover:bg-rose-500/10 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-400 dark:hover:bg-rose-500/20"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            <span>SAIR DA CONTA</span>
          </button>
        </div>
      )}
    </div>
  );

  return (
    <>
      {/* Desktop persistent sidebar */}
      <aside className="hidden lg:flex lg:w-80 lg:shrink-0 lg:flex-col lg:border-r lg:border-slate-200 dark:lg:border-slate-800">
        {sidebarContent}
      </aside>

      {/* Mobile slide-over drawer */}
      {open && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-xs"
            onClick={onClose}
            aria-hidden="true"
          />
          <div className="relative z-10 flex w-[84vw] max-w-xs flex-col border-r border-slate-200 shadow-2xl dark:border-slate-800">
            {sidebarContent}
          </div>
        </div>
      )}
    </>
  );
}
