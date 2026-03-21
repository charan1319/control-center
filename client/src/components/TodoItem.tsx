import { useState, useRef, useCallback } from 'react';
import { api } from '../api';
import { useToast } from './Toast';
import type { Todo } from '../types';
import './TodoItem.css';

interface TodoItemProps {
  todo: Todo;
  onRefresh: () => void;
  sessionStopped: boolean;
}

export function TodoItem({ todo, onRefresh, sessionStopped }: TodoItemProps) {
  const { showToast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState(todo.details || '');
  const [showLaunchPopover, setShowLaunchPopover] = useState(false);
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [stoppedDismissed, setStoppedDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const detailsRef = useRef<HTMLTextAreaElement>(null);

  const handleDetailsBlur = useCallback(async () => {
    if (details === (todo.details || '')) return;
    try {
      await api.updateTodo(todo.id, { details });
    } catch {
      showToast('Failed to save details', 'error');
    }
  }, [todo.id, todo.details, details, showToast]);

  const handleLaunch = useCallback(async () => {
    setBusy(true);
    try {
      await api.launchTodo(todo.id, skipPermissions);
      showToast(`Launched: ${todo.title}`, 'success');
      setShowLaunchPopover(false);
      setSkipPermissions(false);
      onRefresh();
    } catch (err) {
      showToast(`Launch failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    } finally {
      setBusy(false);
    }
  }, [todo.id, todo.title, skipPermissions, showToast, onRefresh]);

  const handleMarkDone = useCallback(async () => {
    setBusy(true);
    try {
      await api.updateTodo(todo.id, { status: 'done' });
      onRefresh();
    } catch {
      showToast('Failed to update', 'error');
    } finally {
      setBusy(false);
    }
  }, [todo.id, showToast, onRefresh]);

  const handleDelete = useCallback(async () => {
    setBusy(true);
    try {
      await api.deleteTodo(todo.id);
      onRefresh();
    } catch {
      showToast('Failed to delete', 'error');
    } finally {
      setBusy(false);
      setShowDeleteConfirm(false);
    }
  }, [todo.id, showToast, onRefresh]);

  const showStopped = sessionStopped && todo.status === 'in_progress' && !stoppedDismissed;

  return (
    <div className={`todo-item status-${todo.status}`}>
      <div className="todo-item-row">
        <span className={`todo-status-dot ${todo.status}`} />
        <span
          className="todo-title"
          onClick={() => setExpanded(v => !v)}
          title={todo.title}
        >
          {todo.title}
        </span>
        <div className="todo-actions">
          {todo.status === 'pending' && (
            <button
              className="btn-todo-launch"
              onClick={() => setShowLaunchPopover(v => !v)}
              disabled={busy}
            >
              Launch
            </button>
          )}
          {todo.status === 'in_progress' && (
            <button
              className="btn-todo-done"
              onClick={handleMarkDone}
              disabled={busy}
            >
              Done
            </button>
          )}
          {!showDeleteConfirm ? (
            <button
              className="btn-todo-delete"
              onClick={() => setShowDeleteConfirm(true)}
              disabled={busy}
            >
              Del
            </button>
          ) : (
            <button
              className="btn-todo-delete"
              onClick={handleDelete}
              disabled={busy}
            >
              Confirm?
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="todo-details-area">
          <textarea
            ref={detailsRef}
            className="todo-details-textarea"
            value={details}
            onChange={e => setDetails(e.target.value)}
            onBlur={handleDetailsBlur}
            placeholder="Add details..."
          />
        </div>
      )}

      {showLaunchPopover && (
        <div className="todo-launch-popover">
          <label>
            <input
              type="checkbox"
              checked={skipPermissions}
              onChange={e => setSkipPermissions(e.target.checked)}
            />
            Skip permissions
          </label>
          <div className="todo-launch-popover-actions">
            <button
              className="btn-confirm-launch"
              onClick={handleLaunch}
              disabled={busy}
            >
              {busy ? 'Launching...' : 'Launch'}
            </button>
            <button onClick={() => { setShowLaunchPopover(false); setSkipPermissions(false); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {showStopped && (
        <div className="todo-stopped-prompt">
          <span>Session stopped. Mark as done?</span>
          <button className="btn-yes" onClick={handleMarkDone} disabled={busy}>Yes</button>
          <button className="btn-no" onClick={() => setStoppedDismissed(true)}>No</button>
        </div>
      )}
    </div>
  );
}
