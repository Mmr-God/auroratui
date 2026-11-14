// Per-session file checkpoints: snapshot a file before an agent edit so the user can
// roll back with /undo. Stored under ~/.agent/checkpoints/<session>/<step>/.
import fs from 'node:fs';
import path from 'node:path';

export class Checkpoints {
  constructor(dir) {
    this.dir = dir;
    this.step = 0;
    this.steps = []; // [{ n, files: [{ path, existed, backup }] }]
    this._loadIndex();
  }

  get indexPath() {
    return path.join(this.dir, 'index.json');
  }

  _loadIndex() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      this.steps = Array.isArray(raw) ? raw : [];
      this.step = this.steps.reduce((m, s) => Math.max(m, s.n || 0), 0);
    } catch {
      this.steps = [];
    }
  }

  _saveIndex() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.indexPath, JSON.stringify(this.steps.slice(-50), null, 2));
    } catch {}
  }

  /** Snapshot `file` (absolute path) once per step. Cheap no-op if already saved. */
  save(file, note = '') {
    const abs = path.resolve(file);
    let step = this.steps[this.steps.length - 1];
    if (!step || step.closed) {
      step = { n: ++this.step, at: Date.now(), note, files: [], closed: false };
      this.steps.push(step);
      this._saveIndex();
    }
    if (step.files.some((f) => f.path === abs)) return;
    let existed = false;
    let data = null;
    try {
      const st = fs.statSync(abs);
      if (st.isFile() && st.size <= 8 * 1024 * 1024) {
        data = fs.readFileSync(abs);
        existed = true;
      } else if (st.isFile()) {
        return; // too big to snapshot
      }
    } catch {
      existed = false;
    }
    const backupDir = path.join(this.dir, String(step.n));
    let backup = null;
    if (existed) {
      try {
        fs.mkdirSync(backupDir, { recursive: true });
        backup = path.join(backupDir, String(step.files.length));
        fs.writeFileSync(backup, data);
      } catch {
        backup = null;
      }
    }
    step.files.push({ path: abs, existed, backup });
    this._saveIndex();
  }

  /** Close the current step so the next edit starts a new one. */
  commit() {
    const step = this.steps[this.steps.length - 1];
    if (step) step.closed = true;
  }

  list() {
    return this.steps.map((s) => ({
      n: s.n,
      at: s.at,
      note: s.note,
      files: s.files.map((f) => f.path),
      closed: !!s.closed,
    }));
  }

  /** Restore the newest (or step `n`) checkpoint. Returns { ok, restored, missing } */
  restore(n) {
    const idx = n ? this.steps.findIndex((s) => s.n === n) : this.steps.length - 1;
    if (idx < 0) return { ok: false, restored: [], missing: [], error: '没有可回滚的检查点' };
    const step = this.steps[idx];
    const restored = [];
    const missing = [];
    for (const f of step.files) {
      try {
        if (f.existed && f.backup && fs.existsSync(f.backup)) {
          fs.mkdirSync(path.dirname(f.path), { recursive: true });
          fs.copyFileSync(f.backup, f.path);
          restored.push(f.path);
        } else if (!f.existed) {
          if (fs.existsSync(f.path)) {
            fs.unlinkSync(f.path);
            restored.push(f.path + ' (已删除)');
          }
        } else {
          missing.push(f.path);
        }
      } catch (e) {
        missing.push(`${f.path}: ${e.message}`);
      }
    }
    this.steps.splice(idx, 1);
    this._saveIndex();
    return { ok: true, restored, missing, step: step.n };
  }
}
