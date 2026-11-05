/** Styles shared by the Admin_Modus views (theme variables only, Req 5.7). */
export const ADMIN_STYLES = `
  :host {
    display: grid;
    gap: 1.25rem;
  }
  h1,
  h2,
  h3 {
    margin: 0;
  }
  h2 {
    font-size: 1.15rem;
  }
  h3 {
    font-size: 1rem;
  }
  .card {
    display: grid;
    gap: 0.75rem;
    padding: 1.25rem 1.5rem;
    min-width: 0;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.5rem;
    align-items: center;
    justify-content: space-between;
  }
  .note,
  .error,
  .success {
    margin: 0;
    font-size: 0.9rem;
  }
  .note {
    color: var(--color-text-muted);
  }
  .error {
    color: var(--color-error);
  }
  .error:empty {
    display: none;
  }
  .unavailable {
    color: var(--color-text-muted);
    font-style: italic;
  }
  form.inline {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 1rem;
    align-items: flex-end;
  }
  .field {
    display: grid;
    gap: 0.25rem;
    font-size: 0.875rem;
  }
  .field > span,
  label {
    color: var(--color-text-muted);
  }
  input,
  select {
    padding: 0.4rem 0.7rem;
    border: 1px solid var(--color-surface-border);
    border-radius: 0.75rem;
    background: var(--color-surface);
    color: inherit;
    font: inherit;
  }
  option {
    color: var(--color-on-accent);
  }
  [aria-invalid='true'] {
    border-color: var(--color-error);
  }
  .scroll {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  th,
  td {
    padding: 0.45rem 0.65rem;
    text-align: left;
    border-bottom: 1px solid var(--color-surface-border);
    vertical-align: top;
  }
  thead th {
    color: var(--color-text-muted);
    font-weight: 600;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .pill {
    display: inline-block;
    justify-self: start;
    padding: 0.4rem 1.1rem;
    border: 1px solid var(--color-surface-border);
    border-radius: var(--radius-pill);
    background: transparent;
    color: inherit;
    font: inherit;
    text-decoration: none;
    cursor: pointer;
  }
  .pill.primary {
    border-color: transparent;
    background: var(--brand-secondary);
    color: var(--color-on-accent);
  }
  .pill.danger {
    border-color: var(--color-error);
    color: var(--color-error);
  }
  .pill:disabled {
    opacity: 0.5;
    cursor: default;
  }
  a {
    color: var(--brand-secondary);
  }
  .badge {
    padding: 0.1rem 0.55rem;
    border: 1px solid var(--color-surface-border);
    border-radius: var(--radius-pill);
    white-space: nowrap;
  }
  .badge.alarm,
  .badge.suspended {
    border-color: var(--color-error);
    color: var(--color-error);
    font-weight: 600;
  }
  .subnav {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .subnav a {
    color: var(--color-text-muted);
    text-decoration: none;
  }
  .subnav a.active,
  .subnav a:hover {
    color: var(--brand-secondary);
  }
  .pager {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.75rem;
  }
  code {
    word-break: break-all;
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
`;
