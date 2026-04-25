/**
 * Search combobox for adding a resource to the project roster.
 * Passes ?exclude_project= so already-rostered resources are hidden.
 *
 * When the search returns no results and the user has typed a name, a
 * "+ Create '{query}' as a new resource" option is shown at the bottom of
 * the dropdown (issue #155, Sarah's VoC ask). Selecting it creates the
 * Resource org-record and immediately adds it to the project roster.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';

interface ResourceOption {
  id: string;
  name: string;
  job_role: string;
}

function useRosterCandidates(query: string, excludeProjectId: string) {
  return useQuery({
    queryKey: ['resources', 'roster-candidates', excludeProjectId, query],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ResourceOption>>('/resources/', {
        params: { search: query, exclude_project: excludeProjectId },
      });
      return res.data.results;
    },
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Inline-create hook — creates a Resource then adds it to the project roster
// ---------------------------------------------------------------------------

function useInlineCreateResource(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      // 1. Create the org-level Resource record
      const createRes = await apiClient.post<{ id: string }>('/resources/', {
        name,
        email: '',
        job_role: '',
        max_units: 1.0,
      });
      const resourceId = createRes.data.id;
      // 2. Add to project roster
      await apiClient.post('/project-resources/', {
        project: projectId,
        resource: resourceId,
      });
      return resourceId;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['org-resources'] });
      void queryClient.invalidateQueries({ queryKey: ['project-resource-pool', projectId] });
    },
  });
}

export interface AddToRosterComboboxProps {
  projectId: string;
  onSelect: (resourceId: string) => void;
  onDismiss: () => void;
}

export function AddToRosterCombobox({ projectId, onSelect, onDismiss }: AddToRosterComboboxProps) {
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const inlineCreate = useInlineCreateResource(projectId);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(id);
  }, [query]);

  const { data: results = [] } = useRosterCandidates(debouncedQuery, projectId);
  const visible = results.slice(0, 20);

  // Show inline-create option when there are no matches and the user has typed something
  const trimmedQuery = query.trim();
  const showCreateOption = trimmedQuery.length > 0 && visible.length === 0;
  // Total navigable items: existing results + optional create option
  const totalOptions = visible.length + (showCreateOption ? 1 : 0);
  const createOptionIndex = visible.length; // always last

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveIndex(-1);
  }, [debouncedQuery]);

  function handleCreateNew() {
    inlineCreate.mutate(trimmedQuery, {
      onSuccess: (resourceId) => onSelect(resourceId),
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((prev) => Math.min(prev + 1, totalOptions - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (showCreateOption && activeIndex === createOptionIndex) {
          handleCreateNew();
        } else if (activeIndex >= 0 && activeIndex < visible.length) {
          onSelect(visible[activeIndex].id);
        }
        break;
      case 'Escape':
        e.preventDefault();
        onDismiss();
        break;
    }
  }

  const activeOptionId =
    activeIndex >= 0 && activeIndex < totalOptions
      ? `${listboxId}-option-${activeIndex}`
      : undefined;

  const dropdownOpen = visible.length > 0 || showCreateOption;

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={dropdownOpen}
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        aria-label="Search by name…"
        placeholder="Search by name…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={inlineCreate.isPending}
        className="w-full text-sm border border-neutral-border rounded-md px-3 py-2
          bg-neutral-surface text-neutral-text-primary placeholder:text-neutral-text-disabled
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
          disabled:opacity-50"
      />

      {dropdownOpen && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="People to add"
          className="absolute left-0 right-0 top-full mt-1 z-50
            max-h-56 overflow-y-auto
            border border-neutral-border rounded-md
            bg-neutral-surface"
        >
          {visible.map((r, i) => (
            <li
              key={r.id}
              id={`${listboxId}-option-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onPointerDown={(e) => {
                e.preventDefault();
                onSelect(r.id);
              }}
              className={[
                'px-3 py-2 text-sm cursor-pointer flex flex-col gap-0.5',
                i === activeIndex
                  ? 'bg-brand-primary/10 text-brand-primary'
                  : 'text-neutral-text-primary hover:bg-neutral-surface-raised',
              ].join(' ')}
            >
              <span className="font-medium">{r.name}</span>
              {r.job_role && (
                <span className="text-xs text-neutral-text-secondary">{r.job_role}</span>
              )}
            </li>
          ))}

          {showCreateOption && (
            <li
              id={`${listboxId}-option-${createOptionIndex}`}
              role="option"
              aria-selected={activeIndex === createOptionIndex}
              onPointerDown={(e) => {
                e.preventDefault();
                handleCreateNew();
              }}
              className={[
                'px-3 py-2 text-sm cursor-pointer border-t border-neutral-border',
                activeIndex === createOptionIndex
                  ? 'bg-brand-primary/10 text-brand-primary'
                  : 'text-neutral-text-secondary hover:bg-neutral-surface-raised',
              ].join(' ')}
            >
              {inlineCreate.isPending
                ? 'Creating…'
                : `+ Create "${trimmedQuery}" as a new resource`}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
