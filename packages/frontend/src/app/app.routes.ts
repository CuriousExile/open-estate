import type { Routes } from '@angular/router';
import { ListingPageComponent } from './listing/listing-page.component';
import { SearchPageComponent } from './search/search-page.component';

/** Routes of the SPA (design: Frontend → Routing). */
export const routes: Routes = [
  { path: '', pathMatch: 'full', component: SearchPageComponent },
  // Öffentliche_Detail_URL (Req 4.19); `:id` is bound to the component input `id`.
  { path: 'listings/:id', component: ListingPageComponent },
  // Agentur_Portal and Admin_Modus (lazy; guarded inside, also the OIDC callback, Req 5.1).
  {
    path: 'portal',
    loadChildren: () => import('./portal/portal.routes').then((m) => m.PORTAL_ROUTES),
  },
  { path: '**', redirectTo: '' },
];
