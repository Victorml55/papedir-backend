import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CoordenadasDto {
  @IsNumber() @Min(-90) @Max(90) lat: number;
  @IsNumber() @Min(-180) @Max(180) lng: number;
}

export class PaginaDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
}

export class MotivoDto {
  @IsString() @IsNotEmpty() @MaxLength(500) motivo: string;
}

export const pagina = <T>(data: T[], total: number, q: PaginaDto) => ({
  data,
  meta: { page: q.page, limit: q.limit, total },
});
