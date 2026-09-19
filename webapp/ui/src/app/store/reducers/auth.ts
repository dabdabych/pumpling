import {createReducer, on} from "@ngrx/store";
import {signIn, signOut} from "../actions/auth";
import {initialAppState} from "../state/app.state";

export const authReducer = createReducer(
  initialAppState,
  on(signIn, state => ({
    ...state,
    isAuthenticated: true
  })),
  on(signOut, state => ({
    ...state,
    isAuthenticated: false
  }))
);
