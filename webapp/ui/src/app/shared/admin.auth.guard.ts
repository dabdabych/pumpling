import { Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot } from '@angular/router';
import { JwtHelperService } from '@auth0/angular-jwt';
@Injectable({
  providedIn: 'root'
})
export class AdminAuthGuard   {
  constructor(private router:Router, private jwtHelper: JwtHelperService){}

  canActivate(route: ActivatedRouteSnapshot, state: RouterStateSnapshot) {
    const token = localStorage.getItem("jwt");
    if (token && !this.jwtHelper.isTokenExpired(token) && this.isAdmin()){
      return true;
    }
    this.router.navigate(["sign-in"]);
    return false;
  }

  isAdmin(): boolean {
    const token = localStorage.getItem("jwt");
    let tokenData = this.jwtHelper.decodeToken(token);
    return tokenData.role.indexOf('admin') !== -1;
  }
}
