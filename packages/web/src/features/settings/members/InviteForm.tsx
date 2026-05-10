import { useState, useRef, useEffect, type FormEvent } from 'react';
import { useUserSearch } from '../hooks/useUserSearch';
import { useAddMember } from '../hooks/useAddMember';
import { RolePicker } from './RolePicker';
import type { UserSearchResult } from '@/api/types';

interface InviteFormProps {
  projectId: string;
}

export function InviteForm({ projectId }: InviteFormProps) {
  const [query, setQuery] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [selectedUser, setSelectedUser] = useState<UserSearchResult | null>(null);
  const [role, setRole] = useState(1); // default: Team Member
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Debounce search input 300 ms
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const { data: results = [], isFetching } = useUserSearch(debouncedQ);
  const { mutate: addMember, isPending, error } = useAddMember(projectId);

  const conflictError =
    error && 'response' in error && (error as { response?: { status?: number } }).response?.status === 409;

  function selectUser(u: UserSearchResult) {
    setSelectedUser(u);
    setQuery(u.username);
    setOpen(false);
    inputRef.current?.focus();
  }

  function clearSelection() {
    setSelectedUser(null);
    setQuery('');
    setDebouncedQ('');
    setOpen(false);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedUser) return;
    addMember(
      { user: selectedUser.id, role },
      {
        onSuccess: () => {
          clearSelection();
          setRole(1);
        },
      },
    );
  }

  const showDropdown = open && debouncedQ.trim().length >= 2 && !selectedUser;

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <p className="text-xs text-neutral-text-secondary">
        Users must have an existing TruePPM account to be added to a project.
      </p>

      <div className="flex flex-col sm:flex-row gap-2">
        {/* Search combobox */}
        <div className="relative flex-1">
          <label htmlFor="invite-search" className="sr-only">
            Search by username or email
          </label>
          <input
            id="invite-search"
            ref={inputRef}
            type="text"
            placeholder="Username or email"
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (selectedUser) setSelectedUser(null);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              // Delay so list click can fire first
              setTimeout(() => setOpen(false), 150);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { clearSelection(); }
              if (e.key === 'ArrowDown' && listRef.current) {
                (listRef.current.querySelector('li') as HTMLElement | null)?.focus();
              }
            }}
            role="combobox"
            aria-autocomplete="list"
            aria-controls="invite-search-listbox"
            aria-expanded={showDropdown}
            className={[
              'h-9 w-full rounded border bg-neutral-surface px-3 text-sm',
              'text-neutral-text-primary placeholder:text-neutral-text-disabled',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
              selectedUser ? 'border-brand-primary' : 'border-neutral-border',
            ].join(' ')}
          />

          {/* Dropdown */}
          {showDropdown && (
            <ul
              id="invite-search-listbox"
              ref={listRef}
              role="listbox"
              aria-label="Search results"
              className={[
                'absolute z-20 mt-1 w-full rounded border border-neutral-border',
                'bg-neutral-surface shadow-none divide-y divide-neutral-border',
                'max-h-52 overflow-y-auto',
              ].join(' ')}
            >
              {isFetching && (
                <li className="px-3 py-2 text-xs text-neutral-text-disabled" aria-live="polite">
                  Searching…
                </li>
              )}
              {!isFetching && results.length === 0 && (
                <li className="px-3 py-2 text-xs text-neutral-text-disabled">
                  No users found. Check the username or email.
                </li>
              )}
              {results.map((u) => (
                <li
                  key={u.id}
                  role="option"
                  aria-selected={false}
                  tabIndex={0}
                  onClick={() => selectUser(u)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') selectUser(u);
                    if (e.key === 'ArrowDown') (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
                    if (e.key === 'ArrowUp') (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus();
                    if (e.key === 'Escape') { setOpen(false); inputRef.current?.focus(); }
                  }}
                  className={[
                    'flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors',
                    'hover:bg-neutral-surface-raised',
                    'focus-visible:outline-none focus-visible:bg-neutral-surface-raised',
                  ].join(' ')}
                >
                  <span
                    aria-hidden="true"
                    className="w-7 h-7 shrink-0 rounded-full bg-brand-primary/10 text-brand-primary
                      text-xs font-semibold flex items-center justify-center"
                  >
                    {u.initials}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium text-neutral-text-primary truncate">
                      {u.display_name}
                    </span>
                    <span className="block text-xs text-neutral-text-secondary truncate">{u.email}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Role picker */}
        <div className="shrink-0">
          <label htmlFor="invite-role" className="sr-only">Role</label>
          <RolePicker id="invite-role" value={role} onChange={setRole} disabled={isPending} />
        </div>

        {/* Submit */}
        <button
          type="submit"
          disabled={!selectedUser || isPending}
          className={[
            'h-9 px-4 rounded border border-brand-primary bg-brand-primary text-white text-sm font-medium',
            'hover:bg-brand-primary/90 transition-colors shrink-0',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          ].join(' ')}
        >
          {isPending ? 'Adding…' : 'Add'}
        </button>
      </div>

      {conflictError && (
        <p role="alert" className="text-xs text-semantic-critical">
          This user is already a member of the project.
        </p>
      )}
      {error && !conflictError && (
        <p role="alert" className="text-xs text-semantic-critical">
          Failed to add member — please try again.
        </p>
      )}
    </form>
  );
}
