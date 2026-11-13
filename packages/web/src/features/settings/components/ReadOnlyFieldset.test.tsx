import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReadOnlyFieldset } from './ReadOnlyFieldset';

describe('<ReadOnlyFieldset>', () => {
  it('renders children unchanged when disabled=false', () => {
    render(
      <ReadOnlyFieldset disabled={false}>
        <input data-testid="i" />
      </ReadOnlyFieldset>,
    );
    const input = screen.getByTestId('i');
    expect(input).not.toBeDisabled();
    expect(input.closest('fieldset')).toBeNull();
  });

  it('wraps children in a disabled fieldset when disabled=true', () => {
    render(
      <ReadOnlyFieldset disabled>
        <input data-testid="i" />
        <button data-testid="b">x</button>
      </ReadOnlyFieldset>,
    );
    expect(screen.getByTestId('i')).toBeDisabled();
    expect(screen.getByTestId('b')).toBeDisabled();
  });

  it('carries the settings-readonly class on the fieldset so globals.css can target descendants', () => {
    render(
      <ReadOnlyFieldset disabled>
        <input />
      </ReadOnlyFieldset>,
    );
    const fieldset = document.querySelector('fieldset');
    expect(fieldset).toHaveClass('settings-readonly');
    expect(fieldset).toHaveAttribute('disabled');
  });
});
