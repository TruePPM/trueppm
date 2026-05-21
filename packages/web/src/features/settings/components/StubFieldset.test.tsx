import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StubFieldset } from './StubFieldset';

describe('<StubFieldset>', () => {
  it('renders children unchanged when disabled=false', () => {
    render(
      <StubFieldset disabled={false}>
        <input data-testid="i" />
      </StubFieldset>,
    );
    const input = screen.getByTestId('i');
    expect(input).not.toBeDisabled();
    expect(input.closest('fieldset')).toBeNull();
  });

  it('wraps children in a disabled fieldset when disabled=true', () => {
    render(
      <StubFieldset disabled>
        <input data-testid="i" />
        <button data-testid="b">x</button>
      </StubFieldset>,
    );
    expect(screen.getByTestId('i')).toBeDisabled();
    expect(screen.getByTestId('b')).toBeDisabled();
  });

  it('carries the settings-stub class on the fieldset so globals.css can target descendants', () => {
    render(
      <StubFieldset disabled>
        <input />
      </StubFieldset>,
    );
    const fieldset = document.querySelector('fieldset');
    expect(fieldset).toHaveClass('settings-stub');
    expect(fieldset).toHaveAttribute('disabled');
  });
});
