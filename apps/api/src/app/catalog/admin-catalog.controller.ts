import { Body, Controller, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { AdminCategoryOption, AdminProductDetail, AdminProductInput, AdminProductQuery, AdminProductRow, AdminVariantInput, Paged, ProductStatus } from '@ecom/contracts';
import { IsArray, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AuthGuard, RequirePermissions } from '../common/auth';
import { AdminCatalogService } from './admin-catalog.service';

const STATUSES: ProductStatus[] = ['draft', 'published', 'archived'];

export class AdminVariantInputDto implements AdminVariantInput {
  @ApiProperty({ required: false }) @IsOptional() @IsString() id?: string;
  @ApiProperty() @IsString() sku!: string;
  @ApiProperty() @IsObject() options!: Record<string, string>;
  @ApiProperty() @IsNumber() @Min(0) price!: number;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() @Min(0) mrp?: number;
  @ApiProperty() @IsInt() @Min(0) stock!: number;
}

export class AdminProductInputDto implements AdminProductInput {
  @ApiProperty() @IsString() title!: string;
  @ApiProperty() @IsString() brandName!: string;
  @ApiProperty() @IsString() categoryId!: string;
  @ApiProperty() @IsString() description!: string;
  @ApiProperty({ type: [String] }) @IsArray() highlights!: string[];
  @ApiProperty({ type: [String] }) @IsArray() tags!: string[];
  @ApiProperty({ enum: STATUSES }) @IsIn(STATUSES) status!: ProductStatus;
  // No @ArrayMinSize here on purpose: "add at least one variant" is the service's own field-level error
  // (matching the mock's message), not a generic 400 from the validation pipe.
  @ApiProperty({ type: [AdminVariantInputDto] }) @IsArray() @ValidateNested({ each: true }) @Type(() => AdminVariantInputDto) variants!: AdminVariantInputDto[];
}

export class BulkIdsDto {
  @ApiProperty({ type: [String] }) @IsArray() ids!: string[];
}

export class BulkStatusDto extends BulkIdsDto {
  @ApiProperty({ enum: STATUSES }) @IsIn(STATUSES) status!: ProductStatus;
}

const int = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

/** Back-office product management (BRD 06's `AdminProductApi`, now backed by the real catalog store). */
@ApiTags('admin-catalog')
@ApiBearerAuth()
@Controller('admin/products')
@UseGuards(AuthGuard)
export class AdminCatalogController {
  constructor(private readonly admin: AdminCatalogService) {}

  @Get()
  @RequirePermissions('product:read')
  list(@Query() q: Record<string, string>): Promise<Paged<AdminProductRow>> {
    const sort = (['updated', 'title', 'price', 'stock'] as const).includes(q['sort'] as never) ? (q['sort'] as AdminProductQuery['sort']) : 'updated';
    const query: AdminProductQuery = {
      ...(q['q'] ? { q: q['q'] } : {}),
      ...(q['status'] && STATUSES.includes(q['status'] as ProductStatus) ? { status: q['status'] as ProductStatus } : {}),
      sort,
      dir: q['dir'] === 'asc' ? 'asc' : 'desc',
      page: int(q['page'], 1),
      pageSize: Math.min(200, int(q['pageSize'], 20)),
    };
    return this.admin.list(query);
  }

  @Get('categories')
  @RequirePermissions('product:read')
  categories(): Promise<AdminCategoryOption[]> {
    return this.admin.categories();
  }

  @Get(':id')
  @RequirePermissions('product:read')
  get(@Param('id') id: string): Promise<AdminProductDetail> {
    return this.admin.get(id);
  }

  @Post()
  @RequirePermissions('product:write')
  create(@Body() body: AdminProductInputDto): Promise<AdminProductDetail> {
    return this.admin.create(body);
  }

  @Put(':id')
  @RequirePermissions('product:write')
  update(@Param('id') id: string, @Body() body: AdminProductInputDto): Promise<AdminProductDetail> {
    return this.admin.update(id, body);
  }

  @Patch('bulk-status')
  @RequirePermissions('product:write')
  bulkSetStatus(@Body() body: BulkStatusDto): Promise<{ count: number }> {
    return this.admin.bulkSetStatus(body.ids, body.status).then((count) => ({ count }));
  }

  @Patch('bulk-delete-drafts')
  @RequirePermissions('product:write')
  bulkDeleteDrafts(@Body() body: BulkIdsDto): Promise<{ count: number }> {
    return this.admin.bulkDeleteDrafts(body.ids).then((count) => ({ count }));
  }
}
