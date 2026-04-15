/**
 * Tests for AssignmentSkeleton — loading placeholder for resource assignment list (#97).
 */
import { screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { AssignmentSkeleton } from './AssignmentSkeleton';

describe('AssignmentSkeleton', () => {
  it('renders with aria-busy and an accessible label', () => {
    renderWithProviders(<AssignmentSkeleton />);
    const skeleton = screen.getByLabelText('Loading resource assignments');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
  });
});
