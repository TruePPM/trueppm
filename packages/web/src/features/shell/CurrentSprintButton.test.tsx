import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { CurrentSprintButton } from './CurrentSprintButton';
import type { SprintJumpTarget } from '@/hooks/useCurrentSprintTargets';

const navigate = vi.fn();
vi.mock('react-router', () => ({ useNavigate: () => navigate }));
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'p1' }));

let targets: SprintJumpTarget[] = [];
vi.mock('@/hooks/useCurrentSprintTargets', () => ({
  useCurrentSprintTargets: () => targets,
}));

const T1: SprintJumpTarget = {
  projectId: 'p1',
  projectName: 'Atlas',
  sprintId: 's1',
  sprintName: 'Sprint 14',
  path: '/projects/p1/board?sprint=s1',
};
const T2: SprintJumpTarget = {
  projectId: 'p3',
  projectName: 'Zephyr',
  sprintId: 's9',
  sprintName: 'Sprint 3',
  path: '/projects/p3/board?sprint=s9',
};

afterEach(() => {
  targets = [];
  vi.clearAllMocks();
});

describe('CurrentSprintButton', () => {
  it('renders nothing when there is no active sprint anywhere', () => {
    targets = [];
    const { container } = render(<CurrentSprintButton />);
    expect(container).toBeEmptyDOMElement();
  });

  it('navigates straight to the sprint board for a single active sprint', () => {
    targets = [T1];
    render(<CurrentSprintButton />);
    const button = screen.getByRole('button', { name: /go to current sprint: sprint 14/i });
    fireEvent.click(button);
    expect(navigate).toHaveBeenCalledWith('/projects/p1/board?sprint=s1');
  });

  it('opens a menu of teams when multiple sprints are active and navigates on choice', () => {
    targets = [T1, T2];
    render(<CurrentSprintButton />);
    const trigger = screen.getByRole('button', { name: /go to current sprint/i });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');

    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: /current sprints/i });
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(2);
    expect(menu).toHaveTextContent('Zephyr');

    fireEvent.click(screen.getByRole('menuitem', { name: /sprint 3/i }));
    expect(navigate).toHaveBeenCalledWith('/projects/p3/board?sprint=s9');
  });
});
