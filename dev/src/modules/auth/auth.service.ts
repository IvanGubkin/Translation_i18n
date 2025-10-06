import { EntityManager } from '@mikro-orm/core';
import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { Organization } from 'db/entitis/Organization';
import { Session } from 'db/entitis/Session';
import { UserRole, Users } from 'db/entitis/Users';
import { jwtConfig, refreshTokenConfig } from 'src/config/jwt.config';
import { LoginDto } from 'src/modules/auth/dto/login.dto';
import { RegisterDto } from 'src/modules/auth/dto/register.dto';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly em: EntityManager,
    private readonly jwtService: JwtService,
  ) {}

  async register(registerDto: RegisterDto): Promise<{
    user: Omit<Users, 'passwordHash'>;
    tokens: Tokens;
  }> {
    // check if user already exists
    const existingUser = await this.em.findOne(Users, {
      email: registerDto.email,
    });
    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    // hash password
    const hashedPassword = await bcrypt.hash(registerDto.password, 12);

    const createOrganization: Organization = this.em.create(Organization, {
      name: registerDto.organizationName,
      createdAt: new Date(),
      updatedAt: new Date(),
      userIds: [],
    });

    await this.em.persistAndFlush(createOrganization);

    // create user
    const user = this.em.create(Users, {
      ...registerDto,
      passwordHash: hashedPassword,
      role: UserRole.OWNER,
      isActive: true,
      isEmailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      organizationId: createOrganization.id,
      projectIds: [],
    });

    await this.em.persistAndFlush(user);

    // Добавляем ID пользователя в массив userIds организации
    if (createOrganization.userIds) {
      createOrganization.userIds.push(user.id);
    } else {
      createOrganization.userIds = [user.id];
    }
    await this.em.persistAndFlush(createOrganization);

    // const jti = crypto.randomUUID();
    const access = await this.jwtService.signAsync(
      { sub: user.id },
      {
        secret: process.env.AT_SECRET,
        expiresIn: '15m',
        audience: 'spa',
        issuer: 'your-app',
      },
    );
    const refresh = await this.jwtService.signAsync(
      { sub: user.id, jti: crypto.randomUUID() },
      {
        secret: process.env.RT_SECRET,
        expiresIn: '7d',
        audience: 'spa',
        issuer: 'your-app',
      },
    );

    // create session
    const session = this.em.create(Session, {
      accessToken: access,
      refreshToken: refresh,
      user: user.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      revoked: false,
      createdAt: new Date(),
    });

    await this.em.persistAndFlush(session);

    // return user and access token
    const { ...userWithoutSensitiveData } = user;
    return {
      user: userWithoutSensitiveData,
      tokens: { accessToken: access, refreshToken: refresh },
    };
  }

  async login(loginDto: LoginDto): Promise<{
    user: Omit<Users, 'passwordHash'>;
    tokens: Tokens;
  }> {
    // find user
    const user = await this.em.findOne(Users, { email: loginDto.email });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Проверяем активность пользователя
    if (!user.isActive) {
      throw new UnauthorizedException('User account is deactivated');
    }

    // Проверяем пароль
    const isPasswordValid = await bcrypt.compare(
      loginDto.password,
      user.passwordHash,
    );
    if (!isPasswordValid) {
      throw new UnauthorizedException('Password is incorrect');
    }

    // Генерируем новые токены
    const tokens = await this.generateTokens(user.id, user.email, user.role);

    // Обновляем время последнего входа
    user.updatedAt = new Date();
    await this.em.persistAndFlush(user);

    // Возвращаем пользователя без пароля
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash, ...userWithoutSensitiveData } = user;
    return { user: userWithoutSensitiveData, tokens };
  }

  // async refreshToken(refreshTokenDto: RefreshTokenDto): Promise<Tokens> {
  //   try {
  //     // Верифицируем refresh token
  //     const payload = await this.jwtService.verifyAsync<JwtPayload>(
  //       refreshTokenDto.refreshToken,
  //       {
  //         secret: refreshTokenConfig.secret,
  //       },
  //     );

  //     // Находим пользователя
  //     const user = await this.em.findOne(User, { id: payload.sub });
  //     if (!user || !user.isActive) {
  //       throw new UnauthorizedException('User not found or inactive');
  //     }

  //     // Проверяем, что refresh token в базе совпадает с переданным
  //     const isRefreshTokenValid = await bcrypt.compare(
  //       refreshTokenDto.refreshToken,
  //       user.refreshToken || '',
  //     );
  //     if (!isRefreshTokenValid) {
  //       throw new UnauthorizedException('Invalid refresh token');
  //     }

  //     // Генерируем новые токены
  //     const tokens = await this.generateTokens(user.id, user.email, user.role);

  //     // Обновляем refresh token в базе
  //     user.refreshToken = await bcrypt.hash(tokens.refreshToken, 12);
  //     user.updatedAt = new Date();
  //     await this.em.persistAndFlush(user);

  //     return tokens;
  //   } catch {
  //     throw new UnauthorizedException('Invalid refresh token');
  //   }
  // }

  // async logout(logoutDto: LogoutDto): Promise<void> {
  //   try {
  //     // Верифицируем refresh token
  //     const payload = await this.jwtService.verifyAsync<JwtPayload>(
  //       logoutDto.refreshToken,
  //       {
  //         secret: refreshTokenConfig.secret,
  //       },
  //     );

  //     // Находим пользователя
  //     const user = await this.em.findOne(User, { id: payload.sub });
  //     if (user) {
  //       // Очищаем refresh token
  //       user.refreshToken = undefined;
  //       user.updatedAt = new Date();
  //       await this.em.persistAndFlush(user);
  //     }
  //   } catch {
  //     // Игнорируем ошибки при logout
  //   }
  // }

  async validateUser(id: string): Promise<Users | null> {
    const user = await this.em.findOne(Users, { id, isActive: true });
    return user;
  }

  // private setRefreshCookie(res: Response, token: string) {
  //   res.cookie('rt', token, {
  //     httpOnly: true,
  //     secure: true,
  //     sameSite: 'strict', // или 'lax'
  //     path: '/auth/refresh',
  //     maxAge: 30 * 24 * 60 * 60 * 1000,
  //   });
  // }

  private async generateTokens(
    userId: string,
    email: string,
    role: string,
  ): Promise<Tokens> {
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(
        {
          sub: userId,
          email,
          role,
        },
        {
          secret: jwtConfig.secret,
          expiresIn: jwtConfig.signOptions?.expiresIn,
          issuer: jwtConfig.signOptions?.issuer,
          audience: jwtConfig.signOptions?.audience,
        },
      ),
      this.jwtService.signAsync(
        {
          sub: userId,
          email,
          role,
        },
        {
          secret: refreshTokenConfig.secret,
          expiresIn: refreshTokenConfig.expiresIn,
          issuer: jwtConfig.signOptions?.issuer,
          audience: jwtConfig.signOptions?.audience,
        },
      ),
    ]);

    return {
      accessToken,
      refreshToken,
    };
  }
}
