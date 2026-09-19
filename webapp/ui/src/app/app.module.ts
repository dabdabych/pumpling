import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import {SharedModule} from "./shared/shared.module";
import {JwtModule} from "@auth0/angular-jwt";
import { StoreModule } from '@ngrx/store';
import { StoreDevtoolsModule } from '@ngrx/store-devtools';
import { environment } from '../environments/environment';
import {StoreRouterConnectingModule} from "@ngrx/router-store";
import {authReducer} from "./store/reducers/auth";
import {BrowserAnimationsModule} from '@angular/platform-browser/animations';
import {ApiConfiguration} from "./api-client/api-configuration";

export function tokenGetter() {
  return localStorage.getItem("jwt");
}

@NgModule({
  declarations: [
    AppComponent
  ],
  imports: [
    BrowserModule,
    AppRoutingModule,
    JwtModule.forRoot({
      config: {
        tokenGetter: tokenGetter,
        // allowedDomains: ["localhost:5001"],
        disallowedRoutes: []
      }
    }),
    SharedModule,
    StoreModule.forRoot({auth: authReducer}),
    StoreDevtoolsModule.instrument({ maxAge: 25, logOnly: environment.production }),
    // EffectsModule.forRoot([UserEffects, ConfigEffects]),
    StoreRouterConnectingModule.forRoot({stateKey: 'router'}),
    BrowserAnimationsModule
  ],
  providers: [
    {
      provide: ApiConfiguration,
      useFactory: () => {
        const config = new ApiConfiguration();
        config.rootUrl = environment.apiUrl;
        return config;
      }
    }
  ],
  bootstrap: [AppComponent]
})
export class AppModule { }
