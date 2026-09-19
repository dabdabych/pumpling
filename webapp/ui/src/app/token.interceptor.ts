import { Injectable } from '@angular/core';
import { HttpRequest, HttpHandler, HttpEvent } from '@angular/common/http';
import {Observable} from "rxjs";


@Injectable()
export class TokenInterceptor {

  /**
   * Creates an instance of TokenInterceptor.
   * @param {OidcSecurityService} auth
   * @memberof TokenInterceptor
   */
  constructor() {}

  /**
   * Intercept all HTTP request to add JWT token to Headers
   * @param {HttpRequest<any>} request
   * @param {HttpHandler} next
   * @returns {Observable<HttpEvent<any>>}
   * @memberof TokenInterceptor
   */
  intercept(request: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {

    request = request.clone({
      setHeaders: {
        Authorization: `Bearer ${localStorage.getItem("jwt")}`
      }
    });

    return next.handle(request);
  }
}
