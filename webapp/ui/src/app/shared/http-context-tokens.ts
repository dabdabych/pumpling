import { HttpContextToken } from '@angular/common/http';

export const SUPPRESS_GLOBAL_ERROR_DIALOG = new HttpContextToken<boolean>(() => false);
