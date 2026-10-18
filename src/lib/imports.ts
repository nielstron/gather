export type ImportStatus = 'ready' | 'queued' | 'running' | 'done' | 'partial' | 'cancelled' | 'error';
export type ImportSummary = {
  id: string; title: string; status: ImportStatus; total: number; unsupported: number;
  imported: number; duplicates: number; failed: number; processed: number;
  created: number; updated: number; error?: string;
  files: { name: string; error?: string }[];
};
