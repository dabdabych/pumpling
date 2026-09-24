import { Directive } from '@angular/core';
import { AbstractControl, NG_VALIDATORS, ValidationErrors, Validator } from '@angular/forms';

import { passwordProblem } from '../password-rules';

/**
 * The password rule on a form control.
 *
 * It returns one message rather than a set of unmet conditions. The previous
 * version returned five booleans at once — lower case, upper case, symbol,
 * digit, length — and the form rendered them as a list that only emptied when
 * every one was met. Somebody trying the site for the first time reported being
 * refused five times over and nearly giving up.
 *
 * The rule itself is in `../password-rules`, which mirrors the server.
 */
@Directive({
  selector: '[passwd-validator]',
  providers: [{
    provide: NG_VALIDATORS,
    useExisting: PasswordValidatorDirective,
    multi: true
  }]
})
export class PasswordValidatorDirective implements Validator {
  validate(control: AbstractControl): ValidationErrors | null {
    const problem = passwordProblem(control.value ?? '');
    return problem ? { password: problem } : null;
  }
}
