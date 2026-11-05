import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { CurrencySelectComponent } from './currency/currency-select.component';
import { LanguageSelectComponent } from './locale/language-select.component';
import { CountrySelectComponent } from './location/country-select.component';
import { ShellLayout } from './shell/shell-layout.service';
import { StartupState } from './startup/startup-state';
import { ThemeSelectComponent } from './theme/theme-select.component';
import { ThemeService } from './theme/theme.service';

/**
 * Root component: the app shell after a successful start, otherwise only the startup error page.
 * The shell has a fixed background layer (hero image + overlay, a calm surface outside the start
 * page) and a header with brand, an optional page slot (the search card of the start page) and the
 * country/currency/language/theme controls; `ShellLayout` switches between hero, searched and page
 * layout.
 */
@Component({
  selector: 'oe-root',
  imports: [
    CountrySelectComponent,
    CurrencySelectComponent,
    LanguageSelectComponent,
    NgTemplateOutlet,
    RouterLink,
    RouterOutlet,
    ThemeSelectComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (errorMessage(); as error) {
      <main class="startup-error" role="alert">
        <h1>{{ error.title }}</h1>
        <p>{{ error.message }}</p>
      </main>
    } @else if (ready()) {
      <div class="oe-backdrop" [class.is-dimmed]="mode() !== 'hero'" aria-hidden="true"></div>
      <header class="site-header" [class]="'site-header--' + mode()">
        <a class="site-brand" routerLink="/">
          <!-- Decorative: the brand name next to it carries the text. -->
          <img class="site-logo" [src]="logoUrl()" alt="" />
          <span class="site-name">{{ appTitle() }}</span>
        </a>
        <div class="site-controls">
          <oe-country-select />
          <oe-currency-select />
          <oe-language-select />
          <oe-theme-select />
        </div>
        @if (headerContent(); as content) {
          <div class="site-header-slot">
            <ng-container *ngTemplateOutlet="content" />
          </div>
        }
      </header>
      <main class="shell" [class]="'shell--' + mode()">
        <router-outlet />
      </main>
    }
  `,
})
export class App {
  private readonly startup = inject(StartupState);
  private readonly theme = inject(ThemeService);
  private readonly layout = inject(ShellLayout);

  protected readonly logoUrl = this.theme.logoUrl;
  protected readonly appTitle = this.theme.appTitle;
  protected readonly mode = this.layout.mode;
  protected readonly headerContent = this.layout.headerContent;

  protected readonly errorMessage = this.startup.errorMessage;
  protected readonly ready = computed(() => this.startup.context() !== undefined);
}
