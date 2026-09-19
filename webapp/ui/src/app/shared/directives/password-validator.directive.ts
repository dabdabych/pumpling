import { Directive } from '@angular/core';
import {AbstractControl, NG_VALIDATORS, Validator} from "@angular/forms";

@Directive({
    selector: '[passwd-validator]',
    providers: [{
            provide: NG_VALIDATORS,
            useExisting: PasswordValidatorDirective,
            multi: true
        }]
})
export class PasswordValidatorDirective implements Validator {
  validate(control: AbstractControl) : {[key: string]: any} | null {
    let result = {
      'lower-case': this.needLowerCase(control.value),
      'upper-case': this.needUpperCase(control.value),
      'special-chars': this.needSpecialChars(control.value),
      'digits': this.needDigits(control.value),
      'length': control.value?.length < 8
    };

    for (let key in result) { // if there is any error
      if(result[key])
        return result;
    }

    return null;
  }

  needLowerCase(value): boolean{
    if(!value) return true;
    let regex = /[a-z]/g;
    return value.match(regex) ? false : true;
  }

  needUpperCase(value): boolean{
    if(!value) return true;
    let regex = /[A-Z]/g;
    return value.match(regex) ? false : true;
  }

  needSpecialChars(value): boolean{
    if(!value) return true;
    // The list used to be limited to !@#$%^&*)( — a password like MyPass1- was
    // rejected although it has a special character. We accept anything that is
    // not a letter, a digit or a space.
    let regex = /[^A-Za-z0-9\s]/;
    return value.match(regex) ? false : true;
  }

  needDigits(value): boolean{
    if(!value) return true;
    let regex = /[\d]/g;
    return value.match(regex) ? false : true;
  }
}
