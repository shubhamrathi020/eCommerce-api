import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

// DTOs only guarantee types and sane sizes (so nothing unexpected reaches a service). The user-facing
// validation messages live in the services, identical to the mock adapters the frontend was built against.

export class RegisterDto {
  @ApiProperty({ example: 'Asha Rao' }) @IsString() @MaxLength(200) name!: string;
  @ApiProperty({ example: 'asha@example.com' }) @IsString() @MaxLength(320) email!: string;
  @ApiProperty({ example: 'Str0ngPass' }) @IsString() @MaxLength(200) password!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'demo@shop.test' }) @IsString() @MaxLength(320) email!: string;
  @ApiProperty() @IsString() @MaxLength(200) password!: string;
}

export class TokenDto {
  @ApiProperty() @IsString() @MaxLength(200) token!: string;
}

export class EmailDto {
  @ApiProperty() @IsString() @MaxLength(320) email!: string;
}

export class ResetPasswordDto {
  @ApiProperty() @IsString() @MaxLength(200) token!: string;
  @ApiProperty() @IsString() @MaxLength(200) password!: string;
}
