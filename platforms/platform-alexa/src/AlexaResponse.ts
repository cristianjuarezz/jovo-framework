import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  JovoResponse,
  Type,
  ValidateNested,
} from '@jovotech/output';
import { Response } from './output';

export class AlexaResponse extends JovoResponse {
  @IsString()
  @IsNotEmpty()
  version!: string;

  @IsOptional()
  @IsObject()
  sessionAttributes?: Record<string, unknown>;

  @ValidateNested()
  @Type(() => Response)
  response!: Response;

  hasSessionEnded(): boolean {
    return !!this.response.shouldEndSession;
  }
}
