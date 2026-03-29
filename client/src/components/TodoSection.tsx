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

interface PlanTask {
  title: string;
  details: string;
  priority: number;
  checked: boolean;
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

  // Plan/decompose state
  const [planMode, setPlanMode] = useState(false);
  const [planGoal, setPlanGoal] = useState('');
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planResults, setPlanResults] = useState<PlanTask[] | null>(null);
  const [planCreating, setPlanCreating] = useState(false);
  const planGoalRef = useRef<HTMLTextAreaElement>(null);

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

  // Focus plan goal textarea when plan mode opens
  useEffect(() => {
    if (planMode && !planResults) {
      planGoalRef.current?.focus();
    }
  }, [planMode, planResults]);

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

  const handleDecompose = useCallback(async () => {
    if (!planGoal.trim()) return;
    setPlanLoading(true);
    setPlanError(null);
    try {
      const { tasks } = await api.decomposeTasks(project, planGoal.trim());
      setPlanResults(tasks.map(t => ({ ...t, checked: true })));
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Decomposition failed');
    } finally {
      setPlanLoading(false);
    }
  }, [project, planGoal]);

  const handleTogglePlanTask = useCallback((index: number) => {
    setPlanResults(prev => {
      if (!prev) return prev;
      const next = [...prev];
      next[index] = { ...next[index], checked: !next[index].checked };
      return next;
    });
  }, []);

  const handleEditPlanTitle = useCallback((index: number, title: string) => {
    setPlanResults(prev => {
      if (!prev) return prev;
      const next = [...prev];
      next[index] = { ...next[index], title };
      return next;
    });
  }, []);

  const handleCreateAll = useCallback(async () => {
    const selected = planResults?.filter(t => t.checked) || [];
    if (selected.length === 0) return;
    setPlanCreating(true);
    try {
      for (const task of selected) {
        await api.createTodo({ project, title: task.title, details: task.details, priority: task.priority });
      }
      showToast(`Created ${selected.length} task${selected.length > 1 ? 's' : ''}`, 'success');
      setPlanMode(false);
      setPlanGoal('');
      setPlanResults(null);
      setPlanError(null);
      await fetchTodos();
    } catch {
      showToast('Failed to create tasks', 'error');
    } finally {
      setPlanCreating(false);
    }
  }, [project, planResults, showToast, fetchTodos]);

  const handleCancelPlan = useCallback(() => {
    setPlanMode(false);
    setPlanGoal('');
    setPlanResults(null);
    setPlanError(null);
  }, []);

  const pendingCount = todos.filter(t => t.status !== 'done').length;
  const checkedCount = planResults?.filter(t => t.checked).length ?? 0;

  return (
    <div className="todo-section">
      <div className="todo-header" onClick={() => setExpanded(v => !v)}>
        <span className={`todo-chevron ${expanded ? 'open' : ''}`}>&#9654;</span>
        <span className="todo-header-label">TODOs</span>
        <span className="todo-header-count">({pendingCount})</span>
        <button
          className="btn-todo-plan"
          onClick={e => {
            e.stopPropagation();
            setPlanMode(v => !v);
            if (!expanded) setExpanded(true);
          }}
        >
          Plan
        </button>
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
        {/* Plan/decompose UI */}
        {planMode && (
          <div className="todo-plan-form">
            {!planResults ? (
              <>
                <textarea
                  ref={planGoalRef}
                  className="todo-plan-goal"
                  placeholder="Describe your goal (e.g. 'Add user authentication with OAuth')"
                  value={planGoal}
                  onChange={e => setPlanGoal(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      handleDecompose();
                    }
                    if (e.key === 'Escape') handleCancelPlan();
                  }}
                  rows={2}
                  disabled={planLoading}
                />
                {planError && <div className="todo-plan-error">{planError}</div>}
                <div className="todo-plan-actions">
                  <button
                    className="btn-plan-decompose"
                    onClick={handleDecompose}
                    disabled={planLoading || !planGoal.trim()}
                  >
                    {planLoading ? 'Planning...' : 'Decompose'}
                  </button>
                  <button onClick={handleCancelPlan} disabled={planLoading}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="todo-plan-results-header">
                  <span className="todo-plan-results-label">Planned tasks ({checkedCount}/{planResults.length} selected)</span>
                </div>
                <div className="todo-plan-results">
                  {planResults.map((task, i) => (
                    <div key={i} className={`todo-plan-task ${task.checked ? '' : 'unchecked'}`}>
                      <input
                        type="checkbox"
                        checked={task.checked}
                        onChange={() => handleTogglePlanTask(i)}
                      />
                      <div className="todo-plan-task-content">
                        <input
                          type="text"
                          className="todo-plan-task-title"
                          value={task.title}
                          onChange={e => handleEditPlanTitle(i, e.target.value)}
                        />
                        {task.details && (
                          <div className="todo-plan-task-details">{task.details}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="todo-plan-actions">
                  <button
                    className="btn-plan-create"
                    onClick={handleCreateAll}
                    disabled={planCreating || checkedCount === 0}
                  >
                    {planCreating ? 'Creating...' : `Create ${checkedCount} task${checkedCount !== 1 ? 's' : ''}`}
                  </button>
                  <button
                    onClick={() => { setPlanResults(null); setPlanError(null); }}
                  >
                    Back
                  </button>
                  <button onClick={handleCancelPlan}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {todos.length === 0 && !showAddForm && !planMode && (
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
