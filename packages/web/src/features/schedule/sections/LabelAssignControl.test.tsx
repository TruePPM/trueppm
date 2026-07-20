import type { ComponentProps } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { LabelAssignControl } from './LabelAssignControl';
import type { Label } from '@/hooks/useLabels';
import type { TaskLabel } from '@/types';

// Shape of the create-label `mutate(input, opts)` call the control drives, so the
// per-test `onSuccess`/`onError` callbacks are type-checked rather than `any`.
type CreateLabelMutate = (
  input: { name: string; color: string },
  opts: {
    onSuccess: (label: Pick<Label, 'id' | 'name' | 'color' | 'position'>) => void;
    onError: (error: unknown) => void;
  },
) => void;

const useLabelsMock = vi.hoisted(() => vi.fn());
const useAttachMock = vi.hoisted(() => vi.fn());
const useDetachMock = vi.hoisted(() => vi.fn());
const useCreateMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useLabels', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useLabels')>('@/hooks/useLabels');
  return {
    ...actual,
    useLabels: useLabelsMock,
    useAttachLabel: useAttachMock,
    useDetachLabel: useDetachMock,
    useCreateLabel: useCreateMock,
  };
});

function taskLabel(overrides: Partial<TaskLabel> = {}): TaskLabel {
  return { id: 'tl1', name: 'spec', color: 'teal', position: 0, ...overrides };
}

function catalogLabel(overrides: Partial<Label> = {}): Label {
  return {
    id: 'c1',
    name: 'spec',
    color: 'teal',
    position: 0,
    serverVersion: 1,
    taskCount: 0,
    ...overrides,
  };
}

let attachMutate: ReturnType<typeof vi.fn>;
let detachMutate: ReturnType<typeof vi.fn>;
let createMutate: ReturnType<typeof vi.fn<CreateLabelMutate>>;

beforeEach(() => {
  vi.clearAllMocks();
  attachMutate = vi.fn();
  detachMutate = vi.fn();
  createMutate = vi.fn<CreateLabelMutate>();
  useAttachMock.mockReturnValue({ mutate: attachMutate, isPending: false });
  useDetachMock.mockReturnValue({ mutate: detachMutate, isPending: false });
  useCreateMock.mockReturnValue({ mutate: createMutate, isPending: false });
  useLabelsMock.mockReturnValue({ data: [], isLoading: false });
});

function renderControl(props: Partial<ComponentProps<typeof LabelAssignControl>> = {}) {
  return render(
    <LabelAssignControl
      projectId="p1"
      taskId="t1"
      labels={[]}
      canAssign
      canCreate
      {...props}
    />,
  );
}

describe('LabelAssignControl — pill rendering', () => {
  it('renders assigned pills sorted by position then name', () => {
    renderControl({
      labels: [
        taskLabel({ id: 'b', name: 'beta', position: 2 }),
        taskLabel({ id: 'a', name: 'alpha', position: 1 }),
        taskLabel({ id: 'z', name: 'zeta', position: 1 }),
      ],
    });
    // position 1 before position 2; within position 1, alpha before zeta.
    const names = screen.getAllByText(/alpha|beta|zeta/).map((n) => n.textContent);
    expect(names).toEqual(['alpha', 'zeta', 'beta']);
  });

  it('shows a "No labels" placeholder when the task has none', () => {
    renderControl({ labels: [] });
    expect(screen.getByText('No labels')).toBeInTheDocument();
  });

  it('does not show the placeholder when labels exist', () => {
    renderControl({ labels: [taskLabel({ name: 'spec' })] });
    expect(screen.queryByText('No labels')).toBeNull();
  });
});

describe('LabelAssignControl — assign gate (canAssign)', () => {
  it('hides the "+ Label" trigger from a viewer (canAssign=false)', () => {
    renderControl({ canAssign: false, labels: [taskLabel({ name: 'spec' })] });
    expect(screen.queryByTestId('label-assign-trigger')).toBeNull();
    // Read-only pills still render.
    expect(screen.getByText('spec')).toBeInTheDocument();
  });

  it('shows the trigger (collapsed) when canAssign', () => {
    renderControl();
    const trigger = screen.getByTestId('label-assign-trigger');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // Popover is not mounted until opened.
    expect(screen.queryByTestId('label-popover')).toBeNull();
  });

  it('opens and closes the popover when the trigger is toggled', () => {
    renderControl();
    const trigger = screen.getByTestId('label-assign-trigger');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('label-popover')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('label-popover')).toBeNull();
  });
});

describe('LabelAssignControl — popover close behaviors', () => {
  it('closes the popover on Escape', () => {
    renderControl();
    fireEvent.click(screen.getByTestId('label-assign-trigger'));
    expect(screen.getByTestId('label-popover')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('label-popover')).toBeNull();
  });

  it('closes when a pointerdown lands outside the control', () => {
    renderControl();
    fireEvent.click(screen.getByTestId('label-assign-trigger'));
    expect(screen.getByTestId('label-popover')).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('label-popover')).toBeNull();
  });

  it('stays open when a pointerdown lands inside the control', () => {
    renderControl();
    fireEvent.click(screen.getByTestId('label-assign-trigger'));
    const popover = screen.getByTestId('label-popover');
    fireEvent.pointerDown(popover);
    expect(screen.getByTestId('label-popover')).toBeInTheDocument();
  });
});

describe('LabelAssignControl — popover catalog states', () => {
  it('shows a loading hint while the catalog loads', () => {
    useLabelsMock.mockReturnValue({ data: [], isLoading: true });
    renderControl();
    fireEvent.click(screen.getByTestId('label-assign-trigger'));
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('tells a non-creator (canCreate=false) the catalog is empty and read-only', () => {
    useLabelsMock.mockReturnValue({ data: [], isLoading: false });
    renderControl({ canCreate: false });
    fireEvent.click(screen.getByTestId('label-assign-trigger'));
    expect(
      screen.getByText('No labels yet. An admin or team member can create one.'),
    ).toBeInTheDocument();
  });

  it('filters catalog options by the search query (case-insensitive)', () => {
    useLabelsMock.mockReturnValue({
      data: [
        catalogLabel({ id: 'c1', name: 'Backend' }),
        catalogLabel({ id: 'c2', name: 'Frontend' }),
      ],
      isLoading: false,
    });
    renderControl();
    fireEvent.click(screen.getByTestId('label-assign-trigger'));
    expect(screen.getByTestId('label-option-c1')).toBeInTheDocument();
    expect(screen.getByTestId('label-option-c2')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('label-popover-search'), { target: { value: 'front' } });
    expect(screen.queryByTestId('label-option-c1')).toBeNull();
    expect(screen.getByTestId('label-option-c2')).toBeInTheDocument();
  });
});

describe('LabelAssignControl — attach / detach toggle', () => {
  it('attaches an unassigned label on click and marks it unpressed beforehand', () => {
    useLabelsMock.mockReturnValue({
      data: [catalogLabel({ id: 'c1', name: 'Backend', color: 'blue', position: 3 })],
      isLoading: false,
    });
    renderControl({ labels: [] });
    fireEvent.click(screen.getByTestId('label-assign-trigger'));
    const option = screen.getByTestId('label-option-c1');
    expect(option).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(option);
    expect(attachMutate).toHaveBeenCalledWith({
      taskId: 't1',
      label: { id: 'c1', name: 'Backend', color: 'blue', position: 3 },
    });
    expect(detachMutate).not.toHaveBeenCalled();
  });

  it('detaches an already-assigned label on click and marks it pressed', () => {
    useLabelsMock.mockReturnValue({
      data: [catalogLabel({ id: 'c1', name: 'Backend' })],
      isLoading: false,
    });
    renderControl({ labels: [taskLabel({ id: 'c1', name: 'Backend' })] });
    fireEvent.click(screen.getByTestId('label-assign-trigger'));
    const option = screen.getByTestId('label-option-c1');
    expect(option).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(option);
    expect(detachMutate).toHaveBeenCalledWith({ taskId: 't1', labelId: 'c1' });
    expect(attachMutate).not.toHaveBeenCalled();
  });
});

describe('LabelAssignControl — inline create', () => {
  it('hides the create affordance from a non-creator (canCreate=false)', () => {
    useLabelsMock.mockReturnValue({ data: [], isLoading: false });
    renderControl({ canCreate: false });
    fireEvent.click(screen.getByTestId('label-assign-trigger'));
    fireEvent.change(screen.getByTestId('label-popover-search'), { target: { value: 'New' } });
    expect(screen.queryByTestId('label-create-submit')).toBeNull();
  });

  it('does not offer create when the query exactly matches an existing label', () => {
    useLabelsMock.mockReturnValue({
      data: [catalogLabel({ id: 'c1', name: 'Backend' })],
      isLoading: false,
    });
    renderControl();
    fireEvent.click(screen.getByTestId('label-assign-trigger'));
    fireEvent.change(screen.getByTestId('label-popover-search'), { target: { value: 'backend' } });
    expect(screen.queryByTestId('label-create-submit')).toBeNull();
  });

  it('offers create for a novel non-empty query and submits name + chosen color', () => {
    useLabelsMock.mockReturnValue({ data: [], isLoading: false });
    renderControl();
    fireEvent.click(screen.getByTestId('label-assign-trigger'));
    fireEvent.change(screen.getByTestId('label-popover-search'), { target: { value: 'Novel' } });
    const submit = screen.getByTestId('label-create-submit');
    expect(submit).toHaveTextContent('Create');
    // Pick a non-default color (purple) from the radiogroup.
    fireEvent.click(screen.getByTestId('label-color-purple'));
    expect(screen.getByTestId('label-color-purple')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(submit);
    expect(createMutate).toHaveBeenCalledWith(
      { name: 'Novel', color: 'purple' },
      expect.anything(),
    );
  });

  it('attaches the freshly created label and clears the query on success', () => {
    createMutate.mockImplementation((_input, opts) => {
      opts.onSuccess({ id: 'new1', name: 'Novel', color: 'slate', position: 7 });
    });
    useLabelsMock.mockReturnValue({ data: [], isLoading: false });
    renderControl();
    fireEvent.click(screen.getByTestId('label-assign-trigger'));
    const search = screen.getByTestId<HTMLInputElement>('label-popover-search');
    fireEvent.change(search, { target: { value: 'Novel' } });
    fireEvent.click(screen.getByTestId('label-create-submit'));
    expect(attachMutate).toHaveBeenCalledWith({
      taskId: 't1',
      label: { id: 'new1', name: 'Novel', color: 'slate', position: 7 },
    });
    // The search field is reset after a successful create.
    expect(search.value).toBe('');
  });

  it('surfaces an error message when create fails', () => {
    createMutate.mockImplementation((_input, opts) => opts.onError(new Error('dup')));
    useLabelsMock.mockReturnValue({ data: [], isLoading: false });
    renderControl();
    fireEvent.click(screen.getByTestId('label-assign-trigger'));
    fireEvent.change(screen.getByTestId('label-popover-search'), { target: { value: 'Dupe' } });
    fireEvent.click(screen.getByTestId('label-create-submit'));
    expect(
      screen.getByText(/Could not create label\. It may already exist/),
    ).toBeInTheDocument();
    expect(attachMutate).not.toHaveBeenCalled();
  });

  it('does not submit a blank/whitespace-only query', () => {
    useLabelsMock.mockReturnValue({ data: [catalogLabel({ id: 'c1', name: 'x' })], isLoading: false });
    renderControl();
    fireEvent.click(screen.getByTestId('label-assign-trigger'));
    // Whitespace query — create affordance is not shown (query.trim() is empty).
    fireEvent.change(screen.getByTestId('label-popover-search'), { target: { value: '   ' } });
    expect(screen.queryByTestId('label-create-submit')).toBeNull();
  });

  it('replaces the create form with a cap notice when the catalog is at the soft cap', () => {
    const full = Array.from({ length: 50 }, (_, i) =>
      catalogLabel({ id: `c${i}`, name: `label-${i}`, position: i }),
    );
    useLabelsMock.mockReturnValue({ data: full, isLoading: false });
    renderControl();
    fireEvent.click(screen.getByTestId('label-assign-trigger'));
    fireEvent.change(screen.getByTestId('label-popover-search'), { target: { value: 'Novel' } });
    expect(screen.getByText(/Label limit reached \(50\)/)).toBeInTheDocument();
    expect(screen.queryByTestId('label-create-submit')).toBeNull();
  });

  it('disables the create submit while the mutation is pending', () => {
    useCreateMock.mockReturnValue({ mutate: createMutate, isPending: true });
    useLabelsMock.mockReturnValue({ data: [], isLoading: false });
    renderControl();
    fireEvent.click(screen.getByTestId('label-assign-trigger'));
    fireEvent.change(screen.getByTestId('label-popover-search'), { target: { value: 'Novel' } });
    expect(screen.getByTestId('label-create-submit')).toBeDisabled();
  });

  it('renders all eight palette color radios in the create form', () => {
    useLabelsMock.mockReturnValue({ data: [], isLoading: false });
    renderControl();
    fireEvent.click(screen.getByTestId('label-assign-trigger'));
    fireEvent.change(screen.getByTestId('label-popover-search'), { target: { value: 'Novel' } });
    const group = screen.getByRole('radiogroup', { name: 'Label color' });
    expect(within(group).getAllByRole('radio')).toHaveLength(8);
  });
});
