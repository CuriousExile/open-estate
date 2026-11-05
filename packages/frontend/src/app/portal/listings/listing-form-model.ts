// Framework-free model of the listing form (design: ListingFormComponent; Req 5.3, 5.4, 5.5, 5.9).
// The form keeps every input as typed (strings); `validateListingForm` turns the values into the
// request body and checks it with the request schemas of the Management_API from `shared` before
// any call. Kept free of Angular imports so it can be unit-tested with plain Jest.
import {
  CreateListingRequest,
  LISTING_BOUNDS,
  ListingView as ListingViewSchema,
  ManualContentInputBase,
  MANAGEMENT_BOUNDS,
  MINOR_UNIT_SCALE,
  refineListing,
  ReplaceContentRequest,
  Tour,
  typeCodes,
  type ApiError,
  type ListingStatus,
  type ListingView,
  type OfferType,
  type Taxonomy,
} from '@open-estate/shared';
import { z } from 'zod';

export interface OfferValues {
  offerType: OfferType;
  /** SALE: purchase price. */
  price: string;
  /** RENT: cold rent, optional additional costs and warm rent. */
  coldRent: string;
  additionalCosts: string;
  warmRent: string;
  currency: string;
}

export interface TranslationValues {
  locale: string;
  title: string;
  description: string;
}

export interface UrlValues {
  url: string;
}

/** Raw form state; never modified by validation or by a failed call (Req 5.4, 5.5, 5.9). */
export interface ListingFormValues {
  originalLocale: string;
  title: string;
  description: string;
  listingType: string;
  customId: string;
  /** Only sent on creation; status changes of existing listings have their own operation. */
  status: ListingStatus;
  offers: OfferValues[];
  rooms: string;
  area: string;
  address: { street: string; postalCode: string; city: string; country: string };
  geo: { lat: string; lon: string };
  translations: TranslationValues[];
  /** In display order (Req 5.3). */
  media: UrlValues[];
  tours: UrlValues[];
  contact: { name: string; phone: string; email: string };
  /** Empty = the platform stores the Öffentliche_Detail_URL (Req 4.5). */
  sourceUrl: string;
}

/** Lists of the form, in visual order. */
export const FORM_LISTS = ['offers', 'translations', 'media', 'tours'] as const;
export type FormList = (typeof FORM_LISTS)[number];

/** Maximum number of entries per list (from `LISTING_BOUNDS`). */
export const LIST_LIMITS: Readonly<Record<FormList, number>> = {
  offers: LISTING_BOUNDS.offers.max,
  translations: LISTING_BOUNDS.translations.max,
  media: LISTING_BOUNDS.media.max,
  tours: LISTING_BOUNDS.tours.max,
};

export const DEFAULT_CURRENCY = 'EUR';

export function emptyOffer(offerType: OfferType, currency = DEFAULT_CURRENCY): OfferValues {
  return { offerType, price: '', coldRent: '', additionalCosts: '', warmRent: '', currency };
}

export function emptyTranslation(locale = ''): TranslationValues {
  return { locale, title: '', description: '' };
}

/** Initial state of a new listing: one `SALE` offer, status `INACTIVE` (Req 4.2). */
export function emptyFormValues(
  defaults: { originalLocale?: string; currency?: string } = {},
): ListingFormValues {
  return {
    originalLocale: defaults.originalLocale ?? '',
    title: '',
    description: '',
    listingType: '',
    customId: '',
    status: 'INACTIVE',
    offers: [emptyOffer('SALE', defaults.currency)],
    rooms: '',
    area: '',
    address: { street: '', postalCode: '', city: '', country: '' },
    geo: { lat: '', lon: '' },
    translations: [],
    media: [],
    tours: [],
    contact: { name: '', phone: '', email: '' },
    sourceUrl: '',
  };
}

/** Context of the edited listing: base version for the conflict check and the Custom_Id before. */
export interface EditContext {
  baseVersion: number;
  hadCustomId: boolean;
}

/**
 * Checks a `ListingView` response and returns it in API representation: the schema's output
 * converts amounts to minor units, but the form works with the decimal strings as delivered.
 */
export function checkedListingView(value: unknown): ListingView {
  ListingViewSchema.parse(value);
  return value as ListingView;
}

/**
 * Form values of an existing listing. A derived source URL (the Öffentliche_Detail_URL) stays
 * empty, so it is derived again instead of being stored as an explicit value.
 */
export function fromListingView(view: ListingView): {
  values: ListingFormValues;
  context: EditContext;
} {
  const c = view.content;
  const values: ListingFormValues = {
    originalLocale: c.originalLocale,
    title: c.title,
    description: c.description,
    listingType: c.listingType,
    customId: view.customId ?? '',
    status: view.status,
    offers: c.offers.map((offer) =>
      offer.offerType === 'SALE'
        ? { ...emptyOffer('SALE', offer.currency), price: offer.price }
        : {
            ...emptyOffer('RENT', offer.currency),
            coldRent: offer.coldRent,
            additionalCosts: offer.additionalCosts ?? '',
            warmRent: offer.warmRent ?? '',
          },
    ),
    rooms: String(c.rooms),
    area: c.area,
    address: {
      street: c.address.street ?? '',
      postalCode: c.address.postalCode,
      city: c.address.city,
      country: c.address.country,
    },
    geo: c.geo ? { lat: String(c.geo.lat), lon: String(c.geo.lon) } : { lat: '', lon: '' },
    translations: c.translations.map((t) => ({ ...t })),
    media: c.media.map((m) => ({ url: m.url })),
    tours: c.tours.map((t) => ({ url: t.url })),
    contact: {
      name: c.contact?.name ?? '',
      phone: c.contact?.phone ?? '',
      email: c.contact?.email ?? '',
    },
    sourceUrl: view.sourceUrlDerived ? '' : c.sourceUrl,
  };
  return {
    values,
    context: { baseVersion: view.version, hadCustomId: view.customId !== undefined },
  };
}

// ---------------------------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------------------------

/** Decimal input → API representation: trimmed, decimal comma accepted ("1,5" → "1.5"). */
export function normalizeDecimal(input: string): string {
  return input.trim().replace(',', '.');
}

const NUMBER = /^-?\d+(\.\d+)?$/;

/** Number fields (rooms, coordinates): a number if it is one, else the raw text for the schema. */
function toNumber(input: string): number | string | undefined {
  const value = normalizeDecimal(input);
  if (value === '') return undefined;
  return NUMBER.test(value) ? Number(value) : value;
}

const code = (input: string) => input.trim().toUpperCase();

function offerBody(offer: OfferValues): Record<string, unknown> {
  if (offer.offerType === 'SALE') {
    return {
      offerType: 'SALE',
      price: normalizeDecimal(offer.price),
      currency: code(offer.currency),
    };
  }
  const additionalCosts = normalizeDecimal(offer.additionalCosts);
  const warmRent = normalizeDecimal(offer.warmRent);
  return {
    offerType: 'RENT',
    coldRent: normalizeDecimal(offer.coldRent),
    currency: code(offer.currency),
    ...(additionalCosts !== '' && { additionalCosts }),
    ...(warmRent !== '' && { warmRent }),
  };
}

/** Listing_Inhalt in API representation; empty optional inputs are omitted. */
export function contentBody(v: ListingFormValues): Record<string, unknown> {
  const street = v.address.street.trim();
  const geoGiven = v.geo.lat.trim() !== '' || v.geo.lon.trim() !== '';
  const contact = Object.fromEntries(
    Object.entries(v.contact).filter(([, value]) => value.trim() !== ''),
  );
  const sourceUrl = v.sourceUrl.trim();
  return {
    originalLocale: v.originalLocale.trim(),
    title: v.title,
    description: v.description,
    translations: v.translations.map((t) => ({
      locale: t.locale.trim(),
      title: t.title,
      description: t.description,
    })),
    offers: v.offers.map(offerBody),
    listingType: v.listingType,
    rooms: toNumber(v.rooms),
    area: normalizeDecimal(v.area),
    address: {
      city: v.address.city,
      postalCode: v.address.postalCode.trim(),
      country: code(v.address.country),
      ...(street !== '' && { street: v.address.street }),
    },
    ...(geoGiven && { geo: { lat: toNumber(v.geo.lat), lon: toNumber(v.geo.lon) } }),
    ...(sourceUrl !== '' && { sourceUrl }),
    media: v.media.map((m) => ({ url: m.url.trim() })),
    // `providerCode` is derived from the host by the Management_API (Req 16.2).
    tours: v.tours.map((t) => ({ url: t.url.trim() })),
    ...(Object.keys(contact).length > 0 && { contact }),
  };
}

/** `POST /listings` (no context) or `PUT /listings/{id}` (with the edited listing's context). */
export function requestBody(
  values: ListingFormValues,
  context?: EditContext,
): Record<string, unknown> {
  const content = contentBody(values);
  const customId = values.customId.trim();
  if (context === undefined) {
    return { content, status: values.status, ...(customId !== '' && { customId }) };
  }
  return {
    content,
    baseVersion: context.baseVersion,
    // Empty input removes an existing Custom_Id (`null`), else leaves it absent.
    ...(customId !== '' ? { customId } : context.hadCustomId && { customId: null }),
  };
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

/**
 * `ManualContentInput` as the Management_API applies it: listing type from the loaded taxonomy
 * (as `manualContentSchema`), tours without `providerCode` (derived by the API from the host).
 */
export function listingContentSchema(taxonomy?: Taxonomy): z.ZodType {
  const tours = z.array(Tour.pick({ url: true })).max(LISTING_BOUNDS.tours.max);
  const types = taxonomy ? typeCodes(taxonomy) : [];
  return types.length > 0
    ? refineListing(ManualContentInputBase.extend({ tours, listingType: z.enum(types) }))
    : refineListing(ManualContentInputBase.extend({ tours }));
}

/** Request schemas of create (`edit = false`) and update, with the content schema above. */
export function listingRequestSchema(edit: boolean, taxonomy?: Taxonomy): z.ZodType {
  const content = listingContentSchema(taxonomy);
  return edit
    ? ReplaceContentRequest.extend({ content })
    : CreateListingRequest.extend({ content });
}

/** An invalid form field with its message (Req 5.4). */
export interface FormError {
  /** Form path, e.g. `title`, `address.city`, `offers.1.price`, `offers` (the list itself). */
  path: string;
  /** Field name for the label (`portal.field.<field>`). */
  field: string;
  /** Entry of a list the field belongs to, with 1-based position. */
  item?: { list: FormList; position: number };
  /** Transloco key of the message. */
  messageKey: string;
  params?: Readonly<Record<string, number>>;
}

type Message = Pick<FormError, 'messageKey' | 'params'>;

const B = LISTING_BOUNDS;
const decimal = (minor: number) => minor / MINOR_UNIT_SCALE;
const text = (bounds: { min: number; max: number }): Message => ({
  messageKey: 'portal.listings.error.text',
  params: { min: bounds.min, max: bounds.max },
});
const MONEY: Message = {
  messageKey: 'portal.listings.error.money',
  params: { min: decimal(B.money.minMinor), max: decimal(B.money.maxMinor) },
};

/** Message per field name; `custom` = cross-field rule of the schema (duplicate, warm rent). */
function messageFor(field: string, custom: boolean): Message {
  switch (field) {
    case 'title':
      return text(B.title);
    case 'description':
      return { messageKey: 'portal.listings.error.textMax', params: { max: B.description.max } };
    case 'city':
      return text(B.city);
    case 'postalCode':
      return text(B.postalCode);
    case 'street':
      return text(B.street);
    case 'name':
      return text(B.contactName);
    case 'phone':
      return text(B.contactPhone);
    case 'email':
      return text(B.contactEmail);
    case 'customId':
      return text(MANAGEMENT_BOUNDS.customId);
    case 'price':
    case 'coldRent':
    case 'additionalCosts':
      return MONEY;
    case 'warmRent':
      return custom ? { messageKey: 'portal.listings.error.warmRent' } : MONEY;
    case 'currency':
      return { messageKey: 'portal.listings.error.currency' };
    case 'country':
      return { messageKey: 'portal.listings.error.country' };
    case 'area':
      return {
        messageKey: 'portal.listings.error.area',
        params: { min: decimal(B.area.minMinor), max: decimal(B.area.maxMinor) },
      };
    case 'rooms':
      return {
        messageKey: 'portal.listings.error.rooms',
        params: { min: B.rooms.min, max: B.rooms.max, step: B.rooms.step },
      };
    case 'lat':
    case 'lon':
      return { messageKey: 'portal.listings.error.coordinate', params: B[field] };
    case 'sourceUrl':
      return { messageKey: 'portal.listings.error.url', params: { max: B.url.max } };
    case 'url':
      return { messageKey: 'portal.listings.error.httpsUrl', params: { max: B.url.max } };
    case 'locale':
    case 'originalLocale':
      return {
        messageKey: custom
          ? 'portal.listings.error.duplicateLocale'
          : 'portal.listings.error.locale',
      };
    case 'listingType':
      return { messageKey: 'portal.listings.error.listingType' };
    case 'offerType':
      return { messageKey: 'portal.listings.error.offerType' };
    case 'offers':
      return custom
        ? { messageKey: 'portal.listings.error.duplicateOffer' }
        : {
            messageKey: 'portal.listings.error.count',
            params: { min: B.offers.min, max: B.offers.max },
          };
    case 'translations':
    case 'media':
    case 'tours':
      return { messageKey: 'portal.listings.error.listMax', params: { max: LIST_LIMITS[field] } };
    default:
      return { messageKey: 'portal.listings.error.invalid' };
  }
}

const LIST_SET: ReadonlySet<string> = new Set(FORM_LISTS);

/** Form error of a request path (`['content', 'offers', 0, 'price']` or `['customId']`). */
function formError(requestPath: readonly PropertyKey[], custom: boolean): FormError {
  const path = (requestPath[0] === 'content' ? requestPath.slice(1) : requestPath).map((s) =>
    typeof s === 'number' ? s : String(s),
  );
  const strings = path.filter((s): s is string => typeof s === 'string');
  const field = strings.at(-1) ?? 'content';
  const [list, index] = path;
  const item =
    typeof list === 'string' && LIST_SET.has(list) && typeof index === 'number'
      ? { list: list as FormList, position: index + 1 }
      : undefined;
  return {
    path: path.length > 0 ? path.join('.') : 'content',
    field,
    ...(item && { item }),
    ...messageFor(field, custom),
  };
}

/** First error per path, in the order reported. */
function firstPerPath(errors: readonly FormError[]): FormError[] {
  const seen = new Set<string>();
  return errors.filter((e) => !seen.has(e.path) && (seen.add(e.path), true));
}

export type ListingFormResult =
  { ok: true; body: Record<string, unknown> } | { ok: false; errors: FormError[] };

/**
 * Validates the form before any API call (Req 5.4): the request body and the invalid fields come
 * from the same request schema as the Management_API. `values` is never modified.
 */
export function validateListingForm(
  values: ListingFormValues,
  options: { context?: EditContext; taxonomy?: Taxonomy } = {},
): ListingFormResult {
  const body = requestBody(values, options.context);
  const result = listingRequestSchema(options.context !== undefined, options.taxonomy).safeParse(
    body,
  );
  if (result.success) return { ok: true, body };
  const errors = result.error.issues.map((issue) => formError(issue.path, issue.code === 'custom'));
  return { ok: false, errors: firstPerPath(errors) };
}

/**
 * Field errors of a 400 answer (`field` = `content.offers.0.price`, Req 4.4) as form errors;
 * errors without a field are left for the general message.
 */
export function formErrorsFromApi(errors: readonly ApiError[]): FormError[] {
  return firstPerPath(
    errors.flatMap((error) =>
      error.field === undefined || error.code !== 'INVALID_PARAMETER'
        ? []
        : [
            formError(
              error.field.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s)),
              false,
            ),
          ],
    ),
  );
}

/** `details.currentVersion` of a 409 `VERSION_CONFLICT` (Req 4.8, 5.5); else `undefined`. */
export function versionConflict(errors: readonly ApiError[]): number | undefined {
  const conflict = errors.find((e) => e.code === 'VERSION_CONFLICT');
  const current = conflict?.details?.['currentVersion'];
  return typeof current === 'number' && Number.isInteger(current) && current >= 1
    ? current
    : undefined;
}
