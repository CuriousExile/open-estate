import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Themed stand-in for a listing image that is missing or failed to load (Req 16.12): a gold house
 * outline on dark green, filling its container (same aspect ratio as the images). `label` is the
 * accessible text and is also shown below the drawing. Styles: `.oe-placeholder` in styles.scss.
 */
@Component({
  selector: 'oe-image-placeholder',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="oe-placeholder" role="img" [attr.aria-label]="label()">
      <svg viewBox="24 10 72 54" aria-hidden="true">
        <path
          d="M28 58h64M38 58V36L60 18l22 18v22M33 40 60 17l27 23M54 58V45h12v13M71 41h6v6h-6zM43 41h6v6h-6zM72 26v-6h5v10"
        />
      </svg>
      <span aria-hidden="true">{{ label() }}</span>
    </div>
  `,
})
export class ImagePlaceholderComponent {
  readonly label = input.required<string>();
}
