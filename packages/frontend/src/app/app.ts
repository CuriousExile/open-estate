import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LanguageSelectComponent } from './locale/language-select.component';
import { CountrySelectComponent } from './location/country-select.component';
import { StartupState } from './startup/startup-state';
import { ThemeService } from './theme/theme.service';

/** Root component: the app shell after a successful start, otherwise only the startup error page. */
@Component({
  selector: 'oe-root',
  imports: [CountrySelectComponent, LanguageSelectComponent, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (errorMessage(); as error) {
      <main class="startup-error" role="alert">
        <h1>{{ error.title }}</h1>
        <p>{{ error.message }}</p>
      </main>
    } @else if (ready()) {
      <header class="site-header">
        <!-- Decorative: the brand name next to it carries the text. -->
        <img class="site-logo" [src]="logoUrl()" alt="" />
        <span class="site-name">{{ appTitle() }}</span>
        <div class="site-controls">
          <oe-country-select />
          <oe-language-select />
        </div>
      </header>
      <main class="shell">
        <router-outlet />
      </main>
    }
  `,
})
export class App {
  private readonly startup = inject(StartupState);
  private readonly theme = inject(ThemeService);

  protected readonly logoUrl = this.theme.logoUrl;
  protected readonly appTitle = this.theme.appTitle;

  protected readonly errorMessage = this.startup.errorMessage;
  protected readonly ready = computed(() => this.startup.context() !== undefined);
}
