import { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';

/** Role and tenant go together: both chosen or both empty (no /mcp access). The API enforces it too. */
export const roleWithTenant: ValidatorFn = (group: AbstractControl): ValidationErrors | null => {
  const role = group.get('role')?.value as string;
  const databaseKey = group.get('databaseKey')?.value as string;
  return Boolean(role) === Boolean(databaseKey) ? null : { roleWithTenant: true };
};

export const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
