import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  signal,
  type OnInit,
} from '@angular/core';
import { FormArray, NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  DiffResponse,
  LISTING_STATUSES,
  OFFER_TYPES,
  type ListingStatus,
  type OfferType,
} from '@open-estate/shared';
import { CodeLabelPipe } from '../../locale/code-label.pipe';
import { LocaleService } from '../../locale/locale.service';
import { ManagementApiClient } from '../../management/management-api-client.service';
import { StartupState } from '../../startup/startup-state';
import { DiffViewComponent } from '../shared/diff-view/diff-view.component';
import {
  checkedListingView,
  emptyFormValues,
  emptyOffer,
  emptyTranslation,
  formErrorsFromApi,
  fromListingView,
  LIST_LIMITS,
  validateListingForm,
  versionConflict,
  type EditContext,
  type FormError,
  type FormList,
  type ListingFormValues,
  type OfferValues,
  type TranslationValues,
  type UrlValues,
} from './listing-form-model';

/** 409 `VERSION_CONFLICT`: base version of the inputs, current version and their Diff (Req 5.5). */
interface Conflict {
  base: number;
  current: number;
  diff?: DiffResponse;
  diffError?: string;
}

/** Fields of a section, in visual order: name and input kind. */
const ADDRESS_FIELDS = [
  { name: 'street', autocomplete: 'street-address' },
  { name: 'postalCode', autocomplete: 'postal-code' },
  { name: 'city', autocomplete: 'address-level2' },
  { name: 'country', autocomplete: 'country' },
] as const;
const CONTACT_FIELDS = [
  { name: 'name', type: 'text' },
  { name: 'phone', type: 'tel' },
  { name: 'email', type: 'email' },
] as const;

/**
 * `/portal/listings/new` and `/portal/listings/:id/edit` (Req 5.3–5.5, 5.9): reactive form for the
 * full Listing_Inhalt and the Custom_Id. Validates with the Management_API's request schema before
 * any call; on validation errors, API errors, timeouts and version conflicts every input stays as
 * typed. A derived source URL is shown empty, so it stays derived.
 */
@Component({
  selector: 'oe-listing-form',
  imports: [ReactiveFormsModule, RouterLink, TranslocoPipe, CodeLabelPipe, DiffViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="glass panel" aria-labelledby="listing-form-title">
      <header class="head">
        <h1 id="listing-form-title" class="label">
          {{ (editing() ? 'portal.listings.edit' : 'portal.listings.new') | transloco }}
        </h1>
        <a
          class="pill"
          [routerLink]="listingId() ? ['/portal/listings', listingId()] : '/portal/listings'"
        >
          {{ 'portal.listings.form.cancel' | transloco }}
        </a>
      </header>

      @if (loadState() === 'loading') {
        <p class="muted" role="status">{{ 'portal.listings.form.loading' | transloco }}</p>
      } @else if (loadState() === 'failed') {
        <div class="notice error" role="alert">
          <p>{{ errorText() }}</p>
          <button type="button" class="pill" (click)="load()">
            {{ 'portal.listings.retry' | transloco }}
          </button>
        </div>
      } @else {
        @if (conflict(); as c) {
          <section class="notice conflict" role="alert" aria-labelledby="conflict-title">
            <h2 id="conflict-title">{{ 'portal.listings.conflict.title' | transloco }}</h2>
            <p>
              {{
                'portal.listings.conflict.message' | transloco: { base: c.base, current: c.current }
              }}
            </p>
            @if (c.diff; as diff) {
              <oe-diff-view [diff]="diff" />
            } @else if (c.diffError; as message) {
              <p>{{ message }}</p>
            } @else {
              <p class="muted" role="status">
                {{ 'portal.listings.conflict.loading' | transloco }}
              </p>
            }
            <div class="actions">
              <button type="button" class="pill primary" (click)="overwrite(c.current)">
                {{ 'portal.listings.conflict.overwrite' | transloco: { current: c.current } }}
              </button>
              <button type="button" class="pill" (click)="load()">
                {{ 'portal.listings.conflict.discard' | transloco }}
              </button>
            </div>
          </section>
        }

        @if (dropped().length > 0 && listingId(); as id) {
          <div class="notice" role="status">
            <p>
              {{ 'portal.listings.form.dropped' | transloco: { fields: dropped().join(', ') } }}
            </p>
            <a class="pill" [routerLink]="['/portal/listings', id]">
              {{ 'portal.listings.form.open' | transloco }}
            </a>
          </div>
        }

        @if (errors().length > 0 || errorText()) {
          <div class="errors" role="alert">
            @if (errorText(); as message) {
              <p>{{ message }}</p>
            }
            @if (errors().length > 0) {
              <p>{{ 'portal.listings.form.invalid' | transloco: { count: errors().length } }}</p>
              <ul>
                @for (error of errors(); track error.path) {
                  <li [id]="errorId(error.path)">
                    <button type="button" class="link" (click)="focus(error.path)">
                      @if (error.item; as item) {
                        {{
                          'portal.listings.item.' + item.list
                            | transloco: { position: item.position }
                        }}
                      }
                      @if (!error.item || error.field !== error.item.list) {
                        {{ 'portal.field.' + error.field | transloco }}
                      }</button
                    >:
                    {{ error.messageKey | transloco: messageParams(error) }}
                  </li>
                }
              </ul>
            }
          </div>
        }

        <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
          <fieldset>
            <legend class="label">{{ 'portal.listings.section.general' | transloco }}</legend>
            <div class="grid">
              <div class="field">
                <label [for]="fieldId('originalLocale')">{{
                  'portal.field.originalLocale' | transloco
                }}</label>
                <select
                  [id]="fieldId('originalLocale')"
                  data-field="originalLocale"
                  formControlName="originalLocale"
                  [attr.aria-invalid]="invalid('originalLocale')"
                  [attr.aria-describedby]="describedBy('originalLocale')"
                >
                  @for (
                    option of localeOptions(form.controls.originalLocale.value);
                    track option.locale
                  ) {
                    <option [value]="option.locale">{{ option.label }}</option>
                  }
                </select>
              </div>
              <div class="field">
                <label [for]="fieldId('listingType')">{{
                  'portal.field.listingType' | transloco
                }}</label>
                @if (taxonomy; as taxonomy) {
                  <select
                    [id]="fieldId('listingType')"
                    data-field="listingType"
                    formControlName="listingType"
                    [attr.aria-invalid]="invalid('listingType')"
                    [attr.aria-describedby]="describedBy('listingType')"
                  >
                    <option value="">{{ 'portal.listings.form.choose' | transloco }}</option>
                    @for (group of taxonomy.groups; track group.code) {
                      <optgroup [label]="group.code | codeLabel: 'taxonomy.group' | transloco">
                        @for (type of group.types; track type) {
                          <option [value]="type">
                            {{ type | codeLabel: 'taxonomy.type' | transloco }}
                          </option>
                        }
                      </optgroup>
                    }
                  </select>
                } @else {
                  <input
                    [id]="fieldId('listingType')"
                    data-field="listingType"
                    formControlName="listingType"
                    [attr.aria-invalid]="invalid('listingType')"
                    [attr.aria-describedby]="describedBy('listingType')"
                  />
                }
              </div>
              <div class="field">
                <label [for]="fieldId('customId')">{{ 'portal.field.customId' | transloco }}</label>
                <input
                  [id]="fieldId('customId')"
                  data-field="customId"
                  formControlName="customId"
                  autocomplete="off"
                  [attr.aria-invalid]="invalid('customId')"
                  [attr.aria-describedby]="describedBy('customId') ?? 'customId-hint'"
                />
                <small id="customId-hint">{{ 'portal.listings.hint.customId' | transloco }}</small>
              </div>
              @if (!editing()) {
                <div class="field">
                  <label [for]="fieldId('status')">{{ 'portal.field.status' | transloco }}</label>
                  <select [id]="fieldId('status')" data-field="status" formControlName="status">
                    @for (status of statuses; track status) {
                      <option [value]="status">
                        {{ 'portal.listings.status.' + status | transloco }}
                      </option>
                    }
                  </select>
                </div>
              }
              <div class="field wide">
                <label [for]="fieldId('title')">{{ 'portal.field.title' | transloco }}</label>
                <input
                  [id]="fieldId('title')"
                  data-field="title"
                  formControlName="title"
                  [attr.aria-invalid]="invalid('title')"
                  [attr.aria-describedby]="describedBy('title')"
                />
              </div>
              <div class="field wide">
                <label [for]="fieldId('description')">{{
                  'portal.field.description' | transloco
                }}</label>
                <textarea
                  [id]="fieldId('description')"
                  data-field="description"
                  formControlName="description"
                  rows="6"
                  [attr.aria-invalid]="invalid('description')"
                  [attr.aria-describedby]="describedBy('description')"
                ></textarea>
              </div>
            </div>
          </fieldset>

          <fieldset formArrayName="offers">
            <legend class="label">{{ 'portal.field.offers' | transloco }}</legend>
            @for (offer of form.controls.offers.controls; track offer; let i = $index) {
              <div class="item" [formGroupName]="i">
                <div class="item-head">
                  <h3>{{ 'portal.listings.item.offers' | transloco: { position: i + 1 } }}</h3>
                  @if (form.controls.offers.length > 1) {
                    <button type="button" class="pill" (click)="remove('offers', i)">
                      {{ 'portal.listings.form.remove' | transloco }}
                    </button>
                  }
                </div>
                <div class="grid">
                  <div class="field">
                    <label [for]="fieldId('offers.' + i + '.offerType')">{{
                      'portal.field.offerType' | transloco
                    }}</label>
                    <select
                      [id]="fieldId('offers.' + i + '.offerType')"
                      [attr.data-field]="'offers.' + i + '.offerType'"
                      formControlName="offerType"
                      [attr.aria-invalid]="invalid('offers.' + i + '.offerType')"
                      [attr.aria-describedby]="describedBy('offers.' + i + '.offerType')"
                    >
                      @for (type of offerTypes; track type) {
                        <option [value]="type">
                          {{ type | codeLabel: 'offerType' | transloco }}
                        </option>
                      }
                    </select>
                  </div>
                  @for (name of amountFields(offer.controls.offerType.value); track name) {
                    <div class="field">
                      <label [for]="fieldId('offers.' + i + '.' + name)">{{
                        'portal.field.' + name | transloco
                      }}</label>
                      <input
                        [id]="fieldId('offers.' + i + '.' + name)"
                        [attr.data-field]="'offers.' + i + '.' + name"
                        [formControlName]="name"
                        inputmode="decimal"
                        autocomplete="off"
                        [attr.aria-invalid]="invalid('offers.' + i + '.' + name)"
                        [attr.aria-describedby]="describedBy('offers.' + i + '.' + name)"
                      />
                    </div>
                  }
                  <div class="field narrow">
                    <label [for]="fieldId('offers.' + i + '.currency')">{{
                      'portal.field.currency' | transloco
                    }}</label>
                    <input
                      [id]="fieldId('offers.' + i + '.currency')"
                      [attr.data-field]="'offers.' + i + '.currency'"
                      formControlName="currency"
                      maxlength="3"
                      autocomplete="off"
                      [attr.aria-invalid]="invalid('offers.' + i + '.currency')"
                      [attr.aria-describedby]="describedBy('offers.' + i + '.currency')"
                    />
                  </div>
                </div>
              </div>
            }
            @if (form.controls.offers.length < limits.offers) {
              <button type="button" class="pill" data-field="offers" (click)="addOffer()">
                {{ 'portal.listings.form.addOffer' | transloco }}
              </button>
            }
          </fieldset>

          <fieldset>
            <legend class="label">{{ 'portal.listings.section.facts' | transloco }}</legend>
            <div class="grid">
              @for (name of factFields; track name) {
                <div class="field">
                  <label [for]="fieldId(name)">{{ 'portal.field.' + name | transloco }}</label>
                  <input
                    [id]="fieldId(name)"
                    [attr.data-field]="name"
                    [formControlName]="name"
                    inputmode="decimal"
                    autocomplete="off"
                    [attr.aria-invalid]="invalid(name)"
                    [attr.aria-describedby]="describedBy(name)"
                  />
                </div>
              }
            </div>
          </fieldset>

          <fieldset formGroupName="address">
            <legend class="label">{{ 'portal.field.address' | transloco }}</legend>
            <div class="grid">
              @for (field of addressFields; track field.name) {
                <div class="field" [class.wide]="field.name === 'street'">
                  <label [for]="fieldId('address.' + field.name)">{{
                    'portal.field.' + field.name | transloco
                  }}</label>
                  <input
                    [id]="fieldId('address.' + field.name)"
                    [attr.data-field]="'address.' + field.name"
                    [formControlName]="field.name"
                    [attr.autocomplete]="field.autocomplete"
                    [attr.aria-invalid]="invalid('address.' + field.name)"
                    [attr.aria-describedby]="describedBy('address.' + field.name)"
                  />
                </div>
              }
            </div>
          </fieldset>

          <fieldset formGroupName="geo">
            <legend class="label">{{ 'portal.field.geo' | transloco }}</legend>
            <div class="grid">
              @for (name of geoFields; track name) {
                <div class="field">
                  <label [for]="fieldId('geo.' + name)">{{
                    'portal.field.' + name | transloco
                  }}</label>
                  <input
                    [id]="fieldId('geo.' + name)"
                    [attr.data-field]="'geo.' + name"
                    [formControlName]="name"
                    inputmode="decimal"
                    autocomplete="off"
                    [attr.aria-invalid]="invalid('geo.' + name)"
                    [attr.aria-describedby]="describedBy('geo.' + name)"
                  />
                </div>
              }
            </div>
          </fieldset>

          <fieldset formArrayName="translations">
            <legend class="label">{{ 'portal.field.translations' | transloco }}</legend>
            @for (
              translation of form.controls.translations.controls;
              track translation;
              let i = $index
            ) {
              <div class="item" [formGroupName]="i">
                <div class="item-head">
                  <h3>
                    {{ 'portal.listings.item.translations' | transloco: { position: i + 1 } }}
                  </h3>
                  <button type="button" class="pill" (click)="remove('translations', i)">
                    {{ 'portal.listings.form.remove' | transloco }}
                  </button>
                </div>
                <div class="grid">
                  <div class="field">
                    <label [for]="fieldId('translations.' + i + '.locale')">{{
                      'portal.field.locale' | transloco
                    }}</label>
                    <select
                      [id]="fieldId('translations.' + i + '.locale')"
                      [attr.data-field]="'translations.' + i + '.locale'"
                      formControlName="locale"
                      [attr.aria-invalid]="invalid('translations.' + i + '.locale')"
                      [attr.aria-describedby]="describedBy('translations.' + i + '.locale')"
                    >
                      <option value="">{{ 'portal.listings.form.choose' | transloco }}</option>
                      @for (
                        option of localeOptions(translation.controls.locale.value);
                        track option.locale
                      ) {
                        <option [value]="option.locale">{{ option.label }}</option>
                      }
                    </select>
                  </div>
                  <div class="field wide">
                    <label [for]="fieldId('translations.' + i + '.title')">{{
                      'portal.field.title' | transloco
                    }}</label>
                    <input
                      [id]="fieldId('translations.' + i + '.title')"
                      [attr.data-field]="'translations.' + i + '.title'"
                      formControlName="title"
                      [attr.aria-invalid]="invalid('translations.' + i + '.title')"
                      [attr.aria-describedby]="describedBy('translations.' + i + '.title')"
                    />
                  </div>
                  <div class="field wide">
                    <label [for]="fieldId('translations.' + i + '.description')">{{
                      'portal.field.description' | transloco
                    }}</label>
                    <textarea
                      [id]="fieldId('translations.' + i + '.description')"
                      [attr.data-field]="'translations.' + i + '.description'"
                      formControlName="description"
                      rows="4"
                      [attr.aria-invalid]="invalid('translations.' + i + '.description')"
                      [attr.aria-describedby]="describedBy('translations.' + i + '.description')"
                    ></textarea>
                  </div>
                </div>
              </div>
            }
            @if (form.controls.translations.length < limits.translations) {
              <button
                type="button"
                class="pill"
                data-field="translations"
                (click)="addTranslation()"
              >
                {{ 'portal.listings.form.addTranslation' | transloco }}
              </button>
            }
          </fieldset>

          @for (list of urlLists; track list) {
            <fieldset [formArrayName]="list">
              <legend class="label">{{ 'portal.field.' + list | transloco }}</legend>
              <ol class="urls">
                @for (
                  entry of urlControls(list);
                  track entry;
                  let i = $index;
                  let first = $first;
                  let last = $last
                ) {
                  <li class="url-row" [formGroupName]="i">
                    <label class="visually-hidden" [for]="fieldId(list + '.' + i + '.url')">{{
                      'portal.listings.item.' + list | transloco: { position: i + 1 }
                    }}</label>
                    <input
                      [id]="fieldId(list + '.' + i + '.url')"
                      [attr.data-field]="list + '.' + i + '.url'"
                      formControlName="url"
                      type="url"
                      inputmode="url"
                      autocomplete="off"
                      [attr.aria-invalid]="invalid(list + '.' + i + '.url')"
                      [attr.aria-describedby]="describedBy(list + '.' + i + '.url')"
                    />
                    @if (list === 'media') {
                      <button
                        type="button"
                        class="pill"
                        [disabled]="first"
                        [attr.aria-label]="
                          'portal.listings.form.moveUpNamed' | transloco: { position: i + 1 }
                        "
                        (click)="move(list, i, -1)"
                      >
                        {{ 'portal.listings.form.moveUp' | transloco }}
                      </button>
                      <button
                        type="button"
                        class="pill"
                        [disabled]="last"
                        [attr.aria-label]="
                          'portal.listings.form.moveDownNamed' | transloco: { position: i + 1 }
                        "
                        (click)="move(list, i, 1)"
                      >
                        {{ 'portal.listings.form.moveDown' | transloco }}
                      </button>
                    }
                    <button
                      type="button"
                      class="pill"
                      [attr.aria-label]="
                        'portal.listings.form.removeNamed' | transloco: { position: i + 1 }
                      "
                      (click)="remove(list, i)"
                    >
                      {{ 'portal.listings.form.remove' | transloco }}
                    </button>
                  </li>
                }
              </ol>
              @if (urlControls(list).length < limits[list]) {
                <button type="button" class="pill" [attr.data-field]="list" (click)="addUrl(list)">
                  {{ 'portal.listings.form.add.' + list | transloco }}
                </button>
              }
            </fieldset>
          }

          <fieldset formGroupName="contact">
            <legend class="label">{{ 'portal.field.contact' | transloco }}</legend>
            <p class="muted">{{ 'portal.listings.hint.contact' | transloco }}</p>
            <div class="grid">
              @for (field of contactFields; track field.name) {
                <div class="field">
                  <label [for]="fieldId('contact.' + field.name)">{{
                    'portal.field.' + field.name | transloco
                  }}</label>
                  <input
                    [id]="fieldId('contact.' + field.name)"
                    [attr.data-field]="'contact.' + field.name"
                    [formControlName]="field.name"
                    [type]="field.type"
                    autocomplete="off"
                    [attr.aria-invalid]="invalid('contact.' + field.name)"
                    [attr.aria-describedby]="describedBy('contact.' + field.name)"
                  />
                </div>
              }
            </div>
          </fieldset>

          <fieldset>
            <legend class="label">{{ 'portal.field.sourceUrl' | transloco }}</legend>
            <div class="field wide">
              <label [for]="fieldId('sourceUrl')">{{ 'portal.field.sourceUrl' | transloco }}</label>
              <input
                [id]="fieldId('sourceUrl')"
                data-field="sourceUrl"
                formControlName="sourceUrl"
                type="url"
                inputmode="url"
                autocomplete="off"
                [attr.aria-invalid]="invalid('sourceUrl')"
                [attr.aria-describedby]="describedBy('sourceUrl') ?? 'sourceUrl-hint'"
              />
              <small id="sourceUrl-hint">{{ 'portal.listings.hint.sourceUrl' | transloco }}</small>
            </div>
          </fieldset>

          <div class="actions">
            <button type="submit" class="pill primary" [disabled]="saving()">
              {{
                (saving() ? 'portal.listings.form.saving' : 'portal.listings.form.save') | transloco
              }}
            </button>
          </div>
        </form>
      }
    </section>
  `,
  styles: `
    .panel {
      display: grid;
      gap: 1.25rem;
      padding: 1.25rem 1.5rem;
    }
    .head,
    .item-head {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
    }
    h1,
    h2,
    h3 {
      margin: 0;
    }
    h2,
    h3 {
      font-size: 1rem;
    }
    form {
      display: grid;
      gap: 1.5rem;
    }
    fieldset {
      display: grid;
      gap: 0.75rem;
      margin: 0;
      padding: 1rem 1.25rem;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-card);
      min-width: 0;
    }
    legend {
      padding: 0 0.5rem;
    }
    .grid {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem 1rem;
    }
    .field {
      display: grid;
      align-content: start;
      gap: 0.25rem;
      flex: 1 1 12rem;
      font-size: 0.875rem;
    }
    .field.wide {
      flex-basis: 100%;
    }
    .field.narrow {
      flex: 0 1 6rem;
    }
    label,
    small,
    .muted {
      color: var(--color-text-muted);
    }
    .muted {
      margin: 0;
      font-size: 0.875rem;
    }
    input,
    select,
    textarea {
      padding: 0.45rem 0.75rem;
      border: 1px solid var(--color-surface-border);
      border-radius: 0.75rem;
      background: var(--color-surface);
      color: inherit;
      font: inherit;
      min-width: 0;
    }
    option,
    optgroup {
      color: var(--color-on-accent);
    }
    [aria-invalid='true'] {
      border-color: var(--color-error);
      box-shadow: 0 0 0 1px var(--color-error);
    }
    .item {
      display: grid;
      gap: 0.75rem;
      padding-bottom: 0.75rem;
      border-bottom: 1px solid var(--color-surface-border);
    }
    .urls {
      display: grid;
      gap: 0.5rem;
      margin: 0;
      padding-left: 1.5rem;
    }
    .url-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: center;
    }
    .url-row input {
      flex: 1 1 18rem;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
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
    .pill:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .notice {
      display: grid;
      gap: 0.75rem;
      padding: 1rem 1.25rem;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-card);
    }
    .notice p,
    .errors p {
      margin: 0;
    }
    .notice.conflict {
      border-color: var(--brand-secondary);
    }
    .notice.error,
    .errors {
      color: var(--color-error);
    }
    .errors {
      display: grid;
      gap: 0.5rem;
    }
    .errors ul {
      margin: 0;
      padding-left: 1.25rem;
    }
    .errors .link {
      padding: 0;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      text-decoration: underline;
      cursor: pointer;
    }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `,
})
export class ListingFormComponent implements OnInit {
  private readonly api = inject(ManagementApiClient);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly locale = inject(LocaleService);
  private readonly fb = inject(NonNullableFormBuilder);

  /** Route parameter of `:id/edit`; absent on `new`. */
  readonly id = input<string>();

  private readonly meta = inject(StartupState).meta();
  protected readonly taxonomy = this.meta.taxonomy;
  protected readonly statuses = LISTING_STATUSES;
  protected readonly offerTypes = OFFER_TYPES;
  protected readonly limits = LIST_LIMITS;
  protected readonly factFields = ['rooms', 'area'] as const;
  protected readonly geoFields = ['lat', 'lon'] as const;
  protected readonly addressFields = ADDRESS_FIELDS;
  protected readonly contactFields = CONTACT_FIELDS;
  protected readonly urlLists = ['media', 'tours'] as const;

  protected readonly form = this.createForm(
    emptyFormValues({
      originalLocale: this.locale.active() || this.locale.options()[0]?.locale || '',
      ...(this.meta.defaultCurrency !== undefined && { currency: this.meta.defaultCurrency }),
    }),
  );

  /** Listing being edited (also after a create whose response named dropped fields). */
  protected readonly listingId = signal<string | undefined>(undefined);
  protected readonly editing = computed(() => this.listingId() !== undefined);
  protected readonly loadState = signal<'loading' | 'ready' | 'failed'>('ready');
  protected readonly saving = signal(false);
  protected readonly errors = signal<readonly FormError[]>([]);
  protected readonly errorText = signal<string | undefined>(undefined);
  protected readonly conflict = signal<Conflict | undefined>(undefined);
  protected readonly dropped = signal<readonly string[]>([]);
  private readonly errorPaths = computed(() => new Set(this.errors().map((e) => e.path)));

  private context: EditContext | undefined;
  private readonly controller = new AbortController();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.controller.abort());
  }

  ngOnInit(): void {
    const id = this.id();
    if (id !== undefined) {
      this.listingId.set(id);
      void this.load();
    }
  }

  /** Loads the listing to edit; replaces the inputs (also "discard my changes" on a conflict). */
  protected async load(): Promise<void> {
    const id = this.listingId();
    if (id === undefined) return;
    this.loadState.set('loading');
    this.errorText.set(undefined);
    const result = await this.api.get(`/listings/${encodeURIComponent(id)}`, {
      signal: this.controller.signal,
      parse: checkedListingView,
    });
    if (this.controller.signal.aborted) return;
    if (!result.ok) {
      this.errorText.set(this.api.errorMessage(result.error));
      this.loadState.set('failed');
      return;
    }
    const { values, context } = fromListingView(result.value);
    this.context = context;
    this.fill(values);
    this.errors.set([]);
    this.conflict.set(undefined);
    this.dropped.set([]);
    this.loadState.set('ready');
  }

  protected async submit(): Promise<void> {
    if (this.saving()) return;
    const values: ListingFormValues = this.form.getRawValue();
    const result = validateListingForm(values, {
      ...(this.context && { context: this.context }),
      ...(this.taxonomy && { taxonomy: this.taxonomy }),
    });
    if (!result.ok) {
      // No API call; every input stays as typed (Req 5.4).
      this.errors.set(result.errors);
      this.errorText.set(undefined);
      const first = result.errors[0];
      if (first !== undefined) this.focus(first.path);
      return;
    }
    this.errors.set([]);
    this.errorText.set(undefined);
    this.dropped.set([]);
    this.saving.set(true);
    const id = this.listingId();
    const options = { signal: this.controller.signal, parse: checkedListingView };
    const response =
      id === undefined
        ? await this.api.post('/listings', result.body, options)
        : await this.api.put(`/listings/${encodeURIComponent(id)}`, result.body, options);
    if (this.controller.signal.aborted) return;
    this.saving.set(false);

    if (response.ok) {
      const view = response.value;
      const dropped = view.droppedFields ?? [];
      if (dropped.length === 0) {
        void this.router.navigate(['/portal/listings', view.id]);
        return;
      }
      // Stay on the form so the user sees which fields the import rules dropped (Req 4.10).
      this.listingId.set(view.id);
      this.context = { baseVersion: view.version, hadCustomId: view.customId !== undefined };
      this.dropped.set(dropped);
      return;
    }

    const error = response.error;
    this.errorText.set(this.api.errorMessage(error));
    if (error.kind !== 'api') return;
    const current = error.status === 409 ? versionConflict(error.errors) : undefined;
    if (current !== undefined && this.context !== undefined) {
      void this.showConflict(this.context.baseVersion, current);
    } else if (error.status === 400) {
      this.errors.set(formErrorsFromApi(error.errors));
    }
  }

  /** Saves the kept inputs over the current version (after the user has seen the Diff). */
  protected overwrite(current: number): void {
    if (this.context !== undefined) this.context = { ...this.context, baseVersion: current };
    this.conflict.set(undefined);
    void this.submit();
  }

  /** Diff between the version the inputs are based on and the current one (Req 5.5). */
  private async showConflict(base: number, current: number): Promise<void> {
    const id = this.listingId();
    if (id === undefined) return;
    this.conflict.set({ base, current });
    const result = await this.api.get(`/listings/${encodeURIComponent(id)}/diff`, {
      query: { from: base, to: current },
      signal: this.controller.signal,
      parse: (value) => DiffResponse.parse(value),
    });
    if (this.controller.signal.aborted || this.conflict()?.current !== current) return;
    this.conflict.set(
      result.ok
        ? { base, current, diff: result.value }
        : { base, current, diffError: this.api.errorMessage(result.error) ?? '' },
    );
  }

  // ---- list editing -------------------------------------------------------------------------

  protected amountFields(type: OfferType): readonly string[] {
    return type === 'SALE' ? ['price'] : ['coldRent', 'additionalCosts', 'warmRent'];
  }

  protected addOffer(): void {
    const used = new Set(this.form.controls.offers.getRawValue().map((o) => o.offerType));
    const type = OFFER_TYPES.find((t) => !used.has(t)) ?? 'SALE';
    const currency = this.form.controls.offers.at(0)?.controls.currency.value;
    this.form.controls.offers.push(this.offerGroup(emptyOffer(type, currency || undefined)));
  }

  protected addTranslation(): void {
    this.form.controls.translations.push(this.translationGroup(emptyTranslation()));
  }

  protected addUrl(list: 'media' | 'tours'): void {
    this.form.controls[list].push(this.urlGroup({ url: '' }));
  }

  protected urlControls(list: 'media' | 'tours') {
    return this.form.controls[list].controls;
  }

  protected remove(list: FormList, index: number): void {
    (this.form.controls[list] as FormArray).removeAt(index);
    // Positions of later entries changed; stale field errors would point at the wrong entry.
    this.errors.set(this.errors().filter((e) => e.item?.list !== list));
  }

  /** Media order is part of the content (Req 5.3). */
  protected move(list: 'media' | 'tours', index: number, delta: -1 | 1): void {
    const array = this.form.controls[list];
    const target = index + delta;
    const control = array.at(index);
    if (target < 0 || target >= array.length || control === undefined) return;
    array.removeAt(index);
    array.insert(target, control);
    this.errors.set(this.errors().filter((e) => e.item?.list !== list));
  }

  // ---- template helpers ---------------------------------------------------------------------

  /** Enabled locales; a value not in the list (e.g. of an imported listing) stays selectable. */
  protected localeOptions(current: string): readonly { locale: string; label: string }[] {
    const options = this.locale.options();
    return current === '' || options.some((o) => o.locale === current)
      ? options
      : [...options, { locale: current, label: current }];
  }

  protected fieldId(path: string): string {
    return `lf-${path.replaceAll('.', '-')}`;
  }

  protected errorId(path: string): string {
    return `lf-error-${path.replaceAll('.', '-')}`;
  }

  protected invalid(path: string): 'true' | null {
    return this.errorPaths().has(path) ? 'true' : null;
  }

  protected describedBy(path: string): string | null {
    return this.errorPaths().has(path) ? this.errorId(path) : null;
  }

  /** Bounds formatted for the active locale (e.g. "0,01"). */
  protected messageParams(error: FormError): Record<string, string> {
    const format = new Intl.NumberFormat(this.locale.active() || undefined, {
      maximumFractionDigits: 6,
    });
    return Object.fromEntries(
      Object.entries(error.params ?? {}).map(([key, value]) => [key, format.format(value)]),
    );
  }

  /** Focuses the input of a form path, or the list's add button for list-level errors. */
  protected focus(path: string): void {
    this.host.nativeElement
      .querySelector<HTMLElement>(`[data-field="${CSS.escape(path)}"]`)
      ?.focus();
  }

  // ---- form construction --------------------------------------------------------------------

  private offerGroup(v: OfferValues) {
    return this.fb.group({
      offerType: this.fb.control<OfferType>(v.offerType),
      price: v.price,
      coldRent: v.coldRent,
      additionalCosts: v.additionalCosts,
      warmRent: v.warmRent,
      currency: v.currency,
    });
  }

  private translationGroup(v: TranslationValues) {
    return this.fb.group({ locale: v.locale, title: v.title, description: v.description });
  }

  private urlGroup(v: UrlValues) {
    return this.fb.group({ url: v.url });
  }

  private createForm(v: ListingFormValues) {
    return this.fb.group({
      originalLocale: v.originalLocale,
      title: v.title,
      description: v.description,
      listingType: v.listingType,
      customId: v.customId,
      status: this.fb.control<ListingStatus>(v.status),
      offers: this.fb.array(v.offers.map((o) => this.offerGroup(o))),
      rooms: v.rooms,
      area: v.area,
      address: this.fb.group({ ...v.address }),
      geo: this.fb.group({ ...v.geo }),
      translations: this.fb.array(v.translations.map((t) => this.translationGroup(t))),
      media: this.fb.array(v.media.map((m) => this.urlGroup(m))),
      tours: this.fb.array(v.tours.map((t) => this.urlGroup(t))),
      contact: this.fb.group({ ...v.contact }),
      sourceUrl: v.sourceUrl,
    });
  }

  /** Replaces all inputs, rebuilding the lists to the loaded lengths. */
  private fill(v: ListingFormValues): void {
    const c = this.form.controls;
    c.offers.clear();
    v.offers.forEach((o) => c.offers.push(this.offerGroup(o)));
    c.translations.clear();
    v.translations.forEach((t) => c.translations.push(this.translationGroup(t)));
    c.media.clear();
    v.media.forEach((m) => c.media.push(this.urlGroup(m)));
    c.tours.clear();
    v.tours.forEach((t) => c.tours.push(this.urlGroup(t)));
    this.form.setValue(v);
  }
}
