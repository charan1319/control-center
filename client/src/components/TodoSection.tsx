import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import { useWebSocket } from '../hooks/useWebSocket';
import { useToast } from './Toast';
import { TodoItem } from './TodoItem';
import type { Todo } from '../types';
import './TodoSection.css';

interface TodoSectionProps {
  project: string;
}

export function TodoSection({ project }: TodoSectionProps) {
  const { showToast } = useToast();
  const { todoStopVersion, getTodoStopEvents } = useWebSocket();

  const [todos, setTodos] = useState<Todo[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDetails, setNewDetails] = useState('');
  const [saving, setSaving] = useState(false);
  const [stoppedTodoIds, setStoppedTodoIds] = useState<Set<number>>(new Set());
  const titleInputRef = useRef<HTMLInputElement>(null);

  const fetchTodos = useCallback(async () => {
    try {
      const result = await api.getTodos(project);
      setTodos(result.todos);
    } catch {
      // Silently fail — the section simply stays empty
    }
  }, [project]);

  // Initial fetch
  useEffect(() => {
    fetchTodos();
  }, [fetchTodos]);

  // Listen for todo_session_stopped WS messages
  useEffect(() => {
    const events = getTodoStopEvents();
    if (events.length === 0) return;

    const projectTodoIds = new Set(todos.map(t => t.id));
    const relevantIds = events
      .filter(e => projectTodoIds.has(e.todo_id))
      .map(e => e.todo_id);

    if (relevantIds.length > 0) {
      setStoppedTodoIds(prev => {
        const next = new Set(prev);
        for (const id of relevantIds) next.add(id);
        return next;
      });
      fetchTodos();
    }
  }, [todoStopVersion, getTodoStopEvents, todos, fetchTodos]);

  // Focus title input when add form opens
  useEffect(() => {
    if (showAddForm) {
      titleInputRef.current?.focus();
    }
  }, [showAddForm]);

  const handleAdd = useCallback(async () => {
    if (!newTitle.trim()) return;
    setSaving(true);
    try {
      await api.createTodo({
        project,
        title: newTitle.trim(),
        details: newDetails.trim() || undefined,
      });
      setNewTitle('');
      setNewDetails('');
      setShowAddForm(false);
      await fetchTodos();
    } catch {
      showToast('Failed to create todo', 'error');
    } finally {
      setSaving(false);
    }
  }, [project, newTitle, newDetails, showToast, fetchTodos]);

  const handleAddKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAdd();
    }
    if (e.key === 'Escape') {
      setShowAddForm(false);
      setNewTitle('');
      setNewDetails('');
    }
  }, [handleAdd]);

  const handleRefresh = useCallback(() => {
    fetchTodos();
  }, [fetchTodos]);

  const pendingCount = todos.filter(t => t.status !== 'done').length;

  return (
    <div className="todo-section">
      <div className="todo-header" onClick={() => setExpanded(v => !v)}>
        <span className={`todo-chevron ${expanded ? 'open' : ''}`}>&#9654;</span>
        <span className="todo-header-label">TODOs</span>
        <span className="todo-header-count">({pendingCount})</span>
        <button
          className="btn-todo-add"
          onClick={e => {
            e.stopPropagation();
            setShowAddForm(v => !v);
            if (!expanded) setExpanded(true);
          }}
        >
          + Add
        </button>
      </div>

      <div className={`todo-body ${expanded ? 'open' : ''}`}>
        {todos.length === 0 && !showAddForm && (
          <div className="todo-empty">No todos yet</div>
        )}

        {todos.length > 0 && (
          <div className="todo-list">
            {todos.map(todo => (
              <TodoItem
                key={todo.id}
                todo={todo}
                onRefresh={handleRefresh}
                sessionStopped={stoppedTodoIds.has(todo.id)}
              />
            ))}
          </div>
        )}

        {showAddForm && (
          <div className="todo-add-form">
            <input
              ref={titleInputRef}
              type="text"
              placeholder="Todo title (required)"
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              onKeyDown={handleAddKeyDown}
            />
            <textarea
              placeholder="Details (optional)"
              value={newDetails}
              onChange={e => setNewDetails(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  setShowAddForm(false);
                  setNewTitle('');
                  setNewDetails('');
                }
              }}
            />
            <div className="todo-add-form-actions">
              <button
                className="btn-save-todo"
                onClick={handleAdd}
                disabled={saving || !newTitle.trim()}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={() => {
                  setShowAddForm(false);
                  setNewTitle('');
                  setNewDetails('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
